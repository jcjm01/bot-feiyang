// api/webhook.js (Vercel - CommonJS)
// WhatsApp -> Node (cuestionarios por producto) -> (Lark create record al finalizar) -> Reply WhatsApp
const { Redis } = require("@upstash/redis");
let LARK_CACHE = { token: null, expiresAtMs: 0 };

// Cache de metadata de fields para:
// - Convertir selects a option_id
// - Formatear fechas según el tipo real del campo
let LARK_FIELDS_CACHE = { byName: null, loadedAtMs: 0 };
const LARK_FIELDS_TTL_MS = 15 * 60 * 1000; // 15 minutos cache por instancia

// dedupe simple en memoria (sirve por instancia)
const SEEN = new Map(); // msgId -> expiresAt
const SEEN_TTL_MS = 5 * 60 * 1000;

// estado en memoria por wa_id (para pruebas). En serverless puede resetear si cambia instancia.
const SESS = new Map(); // wa_id -> { step, data, updatedAt }
const SESS_TTL_MS = 30 * 60 * 1000;
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

// ====== Flow/session version ======
const FLOW_VERSION = "2026-03-25.1";

// ====== Debug logs ======
function logIn({ from, msgId, text, sess, msgTs }) {
  console.log("[IN]", JSON.stringify({
    from: from || null,
    msgId: msgId || null,
    text: String(text || ""),
    msgTs: msgTs || null,
    flowVersion: sess?.flowVersion || null,
    step_before: sess?.step || null,
    producto_before: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
  }));
}

function logStep({ from, msgId, text, stepBefore, sess, note }) {
  console.log("[STEP]", JSON.stringify({
    from: from || null,
    msgId: msgId || null,
    text: String(text || ""),
    note: note || null,
    flowVersion: sess?.flowVersion || null,
    step_before: stepBefore || null,
    step_after: sess?.step || null,
    producto_interes_v2: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
  }));
}

function logFallback({ from, msgId, text, sess, reason }) {
  console.log("[FLOW_FALLBACK]", JSON.stringify({
    from: from || null,
    msgId: msgId || null,
    text: String(text || ""),
    reason: reason || null,
    flowVersion: sess?.flowVersion || null,
    step_before: sess?.step || null,
    producto_interes_v2: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
  }));
}

function logSaveLark({ from, msgId, sess }) {
  console.log("[SAVE_LARK]", JSON.stringify({
    from: from || null,
    msgId: msgId || null,
    flowVersion: sess?.flowVersion || null,
    step_before_save: sess?.step || null,
    producto_interes_v2: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
    qa_resumen: sess?.data?.qa_resumen || null,
    completed: true,
  }));
}

// ====== Placeholder para dedupe compartido (Redis/KV) ======
// Por ahora devuelve false y usamos SEEN local.
// Más adelante aquí conectamos Upstash Redis / Vercel KV.
async function hasSeenMessageShared(msgId) {
  return false;
}

async function markMessageSeenShared(msgId) {
  return;
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function parseMenuChoice(text, min, max) {
  const t = String(text || "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (n < min || n > max) return null;
  return n;
}

function incTry(sess, key) {
  sess.tries = sess.tries || {};
  sess.tries[key] = (sess.tries[key] || 0) + 1;
  return sess.tries[key];
}

function resetTry(sess, key) {
  if (sess?.tries) delete sess.tries[key];
}

function cleanupMaps() {
  const now = Date.now();
  for (const [k, exp] of SEEN) if (exp <= now) SEEN.delete(k);
  for (const [wa, sess] of SESS) if ((sess?.updatedAt || 0) + SESS_TTL_MS <= now) SESS.delete(wa);
}

function redisSessionKey(wa) {
  return `sess:${wa}`;
}

async function saveSession(wa, sess) {
  sess.updatedAt = Date.now();

  // Fallback local por si Redis no está disponible
  SESS.set(wa, sess);

  if (!redis) return;

  await redis.set(redisSessionKey(wa), sess, {
    ex: Math.ceil(SESS_TTL_MS / 1000),
  });
}

async function loadSession(wa) {
  // Si hay Redis, intentamos primero ahí
  if (redis) {
    const sess = await redis.get(redisSessionKey(wa));
    if (sess) {
      sess.updatedAt = Date.now();
      return sess;
    }
  }

  // Fallback local
  const sess = SESS.get(wa);
  if (!sess) return null;
  sess.updatedAt = Date.now();
  return sess;
}

async function deleteSession(wa) {
  SESS.delete(wa);

  if (!redis) return;
  await redis.del(redisSessionKey(wa));
}

async function startSession(wa) {
  const sess = {
    flowVersion: FLOW_VERSION,
    step: "PRODUCTO",
    data: {},
    tries: {},
    handoffHuman: false,
    updatedAt: Date.now(),
  };
  await saveSession(wa, sess);
  return sess;
}

async function getSession(wa) {
  const sess = await loadSession(wa);
  if (!sess) return null;

  if (!sess.flowVersion || sess.flowVersion !== FLOW_VERSION) {
    console.log("[SESSION_VERSION_MISMATCH]", JSON.stringify({
      wa,
      currentFlowVersion: FLOW_VERSION,
      sessionFlowVersion: sess.flowVersion || null,
      oldStep: sess.step || null,
      oldProducto: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
    }));
    await deleteSession(wa);
    return null;
  }

  await saveSession(wa, sess);
  return sess;
}

function pickOption(t, map) {
  const key = String(t || "").trim();
  return map[key] || "";
}

// ====== Mensajes ======

function msgProducto() {
  return (
`Gracias por contactar a FEIYANG MAQUINARIA.
Para orientarte correctamente, indícanos:

¿Qué tipo de equipo láser estás buscando?
(Responde con el número)

1) Limpiadora láser
2) Soldadora láser
3) Marcadora láser
4) Cortadora láser
5) Refacción / soporte técnico`
  );
}

// ---------- LIMPIADORA ----------
function msgLimpQ1() {
  return (
`¿Qué deseas limpiar?
Responde con el número:

1) Remoción de óxido en estructuras metálicas
2) Limpieza de moldes o piezas industriales
3) Mantenimiento eléctrico / torres / altura
4) Remoción de pintura o recubrimientos
5) Estoy evaluando tecnología para mi empresa`
  );
}
function msgLimpQ2() {
  return (
`Actualmente, ¿cómo están resolviendo el problema de limpieza?
Responde con el número:

1) Sandblast
2) Químicos
3) Lijado manual
4) Tercerizan servicio
5) Limpieza con hielo seco
6) No lo hemos resuelto aún`
  );
}
function msgLimpQ3() {
  return (
`Para recomendar la potencia correcta:
¿Cuál es el volumen aproximado de trabajo?
Responde con el número:

1) Uso continuo industrial (turnos / producción diaria)
2) 50–200 piezas por mes
3) Uso ocasional
4) Proyecto aún en análisis`
  );
}
function msgLimpQ4() {
  return (
`¿En qué etapa se encuentra tu proyecto?
Responde con el número:

1) Prioridad inmediata
2) En evaluación técnica
3) Planeación este año
4) Exploración sin fecha definida`
  );
}

// ---------- MARCADORA ----------
function msgMarcQ1() {
  return (
`¿Qué tipo de material deseas marcar?
Responde con el número:

1) Acero / inoxidable
2) Aluminio
3) Plásticos
4) Acrílico / madera
5) Aún no lo defino`
  );
}
function msgMarcQ2() {
  return (
`¿Qué volumen de producción manejas?
Responde con el número:

1) Producción continua / en línea
2) 100–500 piezas por mes
3) Bajo pedido
4) Proyecto en evaluación`
  );
}
function msgMarcQ3() {
  return (
`Actualmente, ¿cómo realizan el marcado?
Responde con el número:

1) Grabado mecánico
2) Etiquetas
3) Tinta / tampografía
4) Tercerizamos
5) No realizamos marcado aún`
  );
}
function msgMarcQ4() {
  return (
`¿En qué etapa se encuentra tu proyecto?
Responde con el número:

1) Necesidad inmediata
2) Comparando proveedores
3) Planeación este año
4) Explorando opciones`
  );
}

// ---------- CORTADORA ----------
function msgCortQ1() {
  return (
`¿Qué material deseas cortar?
Responde con el número:

1) Acero al carbón
2) Acero inoxidable
3) Aluminio
4) Lámina galvanizada
5) Acrílico / MDF
6) Por definir`
  );
}
function msgCortQ2() {
  return (
`¿Cuál es el espesor máximo que necesitas cortar?
Responde con el número:

1) Hasta 3 mm
2) 3–6 mm
3) 6–12 mm
4) Más de 12 mm
5) Aún no lo tengo definido`
  );
}
function msgCortQ3() {
  return (
`¿Qué volumen de producción manejas?
Responde con el número:

1) Producción continua / turnos diarios
2) 100–500 piezas por mes
3) Producción bajo pedido
4) Proyecto en evaluación`
  );
}
function msgCortQ4() {
  return (
`Actualmente, ¿cómo realizan el corte?
Responde con el número:

1) Plasma
2) Oxicorte
3) Sierra / guillotina
4) Tercerizan el servicio
5) No lo realizamos aún`
  );
}
function msgCortQ5() {
  return (
`¿En qué etapa se encuentra tu proyecto?
Responde con el número:

1) Necesidad inmediata
2) Comparando proveedores
3) Planeación este año
4) Explorando opciones`
  );
}

// ---------- SOLDADORA ----------
function msgSoldTipo() {
  return (
`Seleccionaste Soldadora láser.
Elige una opción (número):

1) Reparación de moldes
2) Soldadura de producción`
  );
}

// Rama: Moldes
function msgSoldMoldesQ1() {
  return (
`¿Cuántos moldes necesitas reparar mensualmente?
Responde con el número:

1) 1 a 10
2) 10 a 20
3) 20 a 30
4) Arriba de 30`
  );
}
function msgSoldMoldesQ2() {
  return (
`¿Cuentan con área interna de mantenimiento de moldes?
Responde con el número:

1) Sí, equipo interno
2) Parcial, pero tercerizamos
3) No, todo se envía a externo`
  );
}
function msgSoldMoldesQ3() {
  return (
`¿En qué etapa se encuentra tu proyecto?
Responde con el número:

1) Prioridad inmediata
2) En evaluación técnica
3) Planeación este año
4) Exploración sin fecha definida`
  );
}

// Rama: Producción
function msgSoldProdQ1() {
  return (
`¿Qué tipo de producto deseas soldar?
Responde con el número:

1) Lámina metálica
2) Tubo / Perfil
3) Piezas automotrices
4) Otro`
  );
}
function msgSoldProdQ1Otro() {
  return `Especifica por favor el tipo de producto a soldar (texto breve).`;
}
function msgSoldProdQ2() {
  return (
`¿Qué tipo de material deseas soldar?
Responde con el número:

1) Acero al carbón
2) Acero inoxidable
3) Aluminio
4) Galvanizado
5) Otro`
  );
}
function msgSoldProdQ2Otro() {
  return `Especifica por favor el material a soldar (texto breve).`;
}
function msgSoldProdQ3() {
  return (
`¿Cuál es el espesor aproximado del material?
Responde con el número:

1) Menor a 1 mm
2) 1–3 mm
3) 3–6 mm
4) Más de 6 mm
5) Aún no lo tengo definido`
  );
}
function msgSoldProdQ4() {
  return (
`Actualmente, ¿cómo están realizando la soldadura?
Responde con el número:

1) MIG
2) TIG
3) Electrodo
4) Soldadura tradicional + retrabajo
5) Tercerizan el servicio`
  );
}
function msgSoldProdQ5() {
  return (
`¿Cuál es tu volumen de trabajo mensual?
Responde con el número:

1) Producción continua (turnos diarios)
2) 50–200 piezas por mes
3) Trabajo bajo pedido
4) Proyecto en evaluación`
  );
}

// ---------- SOPORTE ----------
function msgSopQ1() {
  return (
`¿Qué tipo de equipo tienes?
Responde con el número:

1) Limpiadora láser
2) Soldadora láser
3) Marcadora láser
4) Cortadora láser
5) Otro equipo (especificar)`
  );
}
function msgSopQ1Otro() {
  return `Especifica por favor qué equipo tienes (texto breve).`;
}
function msgSopQ2() {
  return (
`¿La máquina es marca FEIYANG MAQUINARIA?
Responde con el número:

1) Sí
2) No`
  );
}
function msgSopQ3() {
  return (
`¿Qué tipo de apoyo necesitas?
Responde con el número:

1) Refacción
2) Mantenimiento
3) Reparación
4) Capacitación
5) Actualización / mejora del equipo`
  );
}

// ---------- Contacto ----------
function msgNombre() {
  return "Excelente. Para continuar, ¿podrías indicarnos tu nombre completo?";
}
function msgEmpresa() {
  return "Gracias. ¿Cuál es el nombre de tu empresa o taller?";
}
function msgUbicacion() {
  return "¿En qué ciudad y estado te encuentras?";
}

function msgEmail() {
  return "Por último, ¿nos compartes tu correo electrónico?";
}

function msgRequiereHumano() {
  return (
`¿Deseas que un asesor de FEIYANG MAQUINARIA te contacte?
Responde con el número:

1) Si
2) No`
  );
}

function isDentroHorarioCDMX() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = fmt.formatToParts(now);
  const wk = (parts.find(p => p.type === "weekday")?.value || "").toLowerCase();
  const hh = Number(parts.find(p => p.type === "hour")?.value || "0");
  const mm = Number(parts.find(p => p.type === "minute")?.value || "0");

  const isWeekday =
    wk.includes("lun") || wk.includes("mar") || wk.includes("mié") || wk.includes("mie") ||
    wk.includes("jue") || wk.includes("vie");

  if (!isWeekday) return false;

  const mins = hh * 60 + mm;
  return mins >= 9 * 60 && mins < 18 * 60;
}

function buildResumen(d) {
  const parts = [];
  const prod = d.producto_interes_v2 || d.producto_interes || "";
  if (prod) parts.push(prod);

  // Limpiadora
  if (d.limp_que_limpia) parts.push(`Limpieza: ${d.limp_que_limpia}`);
  if (d.limp_proceso_actual) parts.push(`Actual: ${d.limp_proceso_actual}`);
  if (d.limp_volumen) parts.push(`Volumen: ${d.limp_volumen}`);
  if (d.limp_etapa) parts.push(`Etapa: ${d.limp_etapa}`);

  // Marcadora
  if (d.marc_material) parts.push(`Material: ${d.marc_material}`);
  if (d.marc_volumen) parts.push(`Volumen: ${d.marc_volumen}`);
  if (d.marc_proceso_actual) parts.push(`Actual: ${d.marc_proceso_actual}`);
  if (d.marc_etapa) parts.push(`Etapa: ${d.marc_etapa}`);

  // Cortadora
  if (d.cort_material) parts.push(`Material: ${d.cort_material}`);
  if (d.cort_espesor) parts.push(`Espesor: ${d.cort_espesor}`);
  if (d.cort_volumen) parts.push(`Volumen: ${d.cort_volumen}`);
  if (d.cort_proceso_actual) parts.push(`Actual: ${d.cort_proceso_actual}`);
  if (d.cort_etapa) parts.push(`Etapa: ${d.cort_etapa}`);

  // Soldadora
  if (d.sold_tipo) parts.push(`Tipo: ${d.sold_tipo}`);
  if (d.sold_moldes_mes) parts.push(`Moldes/mes: ${d.sold_moldes_mes}`);
  if (d.sold_mant_interno) parts.push(`Mant.: ${d.sold_mant_interno}`);
  if (d.sold_etapa) parts.push(`Etapa: ${d.sold_etapa}`);

  if (d.sold_prod_producto) parts.push(`Producto: ${d.sold_prod_producto}${d.sold_prod_producto_otro ? ` (${d.sold_prod_producto_otro})` : ""}`);
  if (d.sold_prod_material) parts.push(`Material: ${d.sold_prod_material}${d.sold_prod_material_otro ? ` (${d.sold_prod_material_otro})` : ""}`);
  if (d.sold_prod_espesor) parts.push(`Espesor: ${d.sold_prod_espesor}`);
  if (d.sold_prod_proceso_actual) parts.push(`Proceso: ${d.sold_prod_proceso_actual}`);
  if (d.sold_prod_volumen_mes) parts.push(`Volumen: ${d.sold_prod_volumen_mes}`);

  // Soporte
  if (d.sop_equipo) parts.push(`Equipo: ${d.sop_equipo}${d.sop_equipo_otro ? ` (${d.sop_equipo_otro})` : ""}`);
  if (d.sop_es_feiyang) parts.push(`Marca Feiyang: ${d.sop_es_feiyang}`);
  if (d.sop_tipo_apoyo) parts.push(`Apoyo: ${d.sop_tipo_apoyo}`);

  return parts.join(" | ");
}

module.exports = async function handler(req, res) {
  const send = (code, body = "OK") => {
    res.statusCode = code;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  };

  const readJsonBody = async () => {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.body && typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  };

  // ========= GET verify =========
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe") {
      if (token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
        return send(200, String(challenge || ""));
      }
      return send(403, "Forbidden");
    }
    return send(200, "ok");
  }

  // ========= POST events =========
  if (req.method === "POST") {
    try {
      cleanupMaps();

      const body = await readJsonBody();
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const msg = value?.messages?.[0];

      // statuses u otros eventos
      if (!msg) return send(200, "OK");

      // dedupe por message id
      const msgId = msg?.id;
const msgTs = msg?.timestamp || null;
const now = Date.now();

// ===== DEDUPE compartido (placeholder) =====
if (msgId) {
  console.log("[DEDUPE_CHECK_SHARED]", JSON.stringify({ msgId }));
  const sharedSeen = await hasSeenMessageShared(msgId);
  if (sharedSeen) {
    console.log("[DEDUPE_HIT_SHARED]", JSON.stringify({ msgId }));
    return send(200, "OK");
  }
}

// ===== DEDUPE local por instancia (actual) =====
if (msgId && SEEN.has(msgId)) {
  console.log("[DEDUPE_HIT_LOCAL]", JSON.stringify({ msgId }));
  return send(200, "OK");
}
if (msgId) {
  SEEN.set(msgId, now + SEEN_TTL_MS);
  console.log("[DEDUPE_SET_LOCAL]", JSON.stringify({ msgId, ttlMs: SEEN_TTL_MS }));
}

// Marcamos también el placeholder compartido
if (msgId) {
  await markMessageSeenShared(msgId);
  console.log("[DEDUPE_SET_SHARED]", JSON.stringify({ msgId }));
}

const from = msg?.from; // wa_id
const text = msg?.text?.body || "";
      const phoneNumberId =
        value?.metadata?.phone_number_id ||
        process.env.WHATSAPP_PHONE_NUMBER_ID ||
        process.env.PHONE_NUMBER_ID;

      const waToken = process.env.WHATSAPP_TOKEN;
      if (!waToken || !phoneNumberId || !from) {
        console.log("MISSING_WHATSAPP_DATA:", { hasToken: !!waToken, phoneNumberId, from });
        return send(200, "OK");
      }

      const waUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
      const t = norm(text);

      // reiniciar/menu
      if (t === "menu" || t === "reiniciar" || t === "reset" || t === "inicio") {
        const sess = await startSession(from);
sess.updatedAt = Date.now();

await sendWhatsAppText(waUrl, waToken, from, msgProducto());
return send(200, "OK");
      }

      // obtener sesión o iniciar
      let sess = await getSession(from);
      if (!sess) {
        sess = await startSession(from);
        console.log("[SESSION_START]", JSON.stringify({
          from,
          flowVersion: sess.flowVersion,
          step: sess.step,
          reason: "NO_ACTIVE_SESSION",
        }));
      
        logIn({ from, msgId, text, sess, msgTs });
      
        await sendWhatsAppText(
          waUrl,
          waToken,
          from,
          "Tu conversación anterior expiró.\n\nTe muestro el menú principal para comenzar de nuevo.\n\n" + msgProducto()
        );
        return send(200, "OK");
      }
      
      logIn({ from, msgId, text, sess, msgTs });

      if (sess?.handoffHuman) {
        console.log("[HANDOFF_HUMAN_SKIP]", JSON.stringify({
          from,
          msgId,
          text: String(text || ""),
          step_before: sess?.step || null,
        }));
        return send(200, "OK");
      }
      
      let reply = "";
      let completed = false;

      
      // ===== PRODUCTO (menú principal) =====
      if (sess.step === "PRODUCTO") {
        const stepBefore = sess.step;
        const choice = parseMenuChoice(text, 1, 5);

  // inválido => contar intento
  if (!choice) {
    const attempt = incTry(sess, "PRODUCTO");

    if (attempt >= 3) {
      // 3er fallo => reiniciar automático
      sess = await startSession(from);
      reply =
        "No logré entender la opción. Reiniciamos ✅\n\n" +
        msgProducto();
      
      logFallback({ from, msgId, text, sess, reason: "PRODUCTO_MAX_TRIES" });  
    } else {
      reply =
        `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
        msgProducto();
    }
  } else {
    // válido => reset intentos de este step
    resetTry(sess, "PRODUCTO");

    let prod = "";
    if (choice === 1) prod = "Limpiadora láser";
    else if (choice === 2) prod = "Soldadora láser";
    else if (choice === 3) prod = "Marcadora láser";
    else if (choice === 4) prod = "Cortadora láser";
    else if (choice === 5) prod = "Refacción / soporte técnico";

    // compatibilidad (viejo) + nuevo
    sess.data.producto_interes = prod;
    sess.data.producto_interes_v2 = prod;

    if (prod === "Limpiadora láser") {
      sess.step = "LIMP_Q1";
      reply = msgLimpQ1();
      logStep({ from, msgId, text, stepBefore, sess, note: "PRODUCTO->LIMP_Q1" });
    
    } else if (prod === "Marcadora láser") {
      sess.step = "MARC_Q1";
      reply = msgMarcQ1();
      logStep({ from, msgId, text, stepBefore, sess, note: "PRODUCTO->MARC_Q1" });
    
    } else if (prod === "Cortadora láser") {
      sess.step = "CORT_Q1";
      reply = msgCortQ1();
      logStep({ from, msgId, text, stepBefore, sess, note: "PRODUCTO->CORT_Q1" });
    
    } else if (prod === "Soldadora láser") {
      sess.step = "SOLD_TIPO";
      reply = msgSoldTipo();
      logStep({ from, msgId, text, stepBefore, sess, note: "PRODUCTO->SOLD_TIPO" });
    
    } else if (prod === "Refacción / soporte técnico") {
      sess.step = "SOP_Q1";
      reply = msgSopQ1();
      logStep({ from, msgId, text, stepBefore, sess, note: "PRODUCTO->SOP_Q1" });
    
    } else {
      // fallback
      reply = msgProducto();
      logFallback({ from, msgId, text, sess, reason: "PRODUCTO_UNKNOWN_SELECTION" });
    }
  }
}

      // ---------- LIMPIADORA ----------
      else if (sess.step === "LIMP_Q1") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "LIMP_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la opción de limpieza. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgLimpQ1();
          }
        } else {
          resetTry(sess, "LIMP_Q1");
      
          const map = {
            1: "Remoción de óxido en estructuras metálicas",
            2: "Limpieza de moldes o piezas industriales",
            3: "Mantenimiento eléctrico / torres / altura",
            4: "Remoción de pintura o recubrimientos",
            5: "Estoy evaluando tecnología para mi empresa",
          };
      
          const val = map[choice];
          if (!val) {
            // fallback ultra seguro
            reply = msgLimpQ1();
          } else {
            sess.data.limp_que_limpia = val;
            sess.step = "LIMP_Q2";
            reply = msgLimpQ2();
          }
        }
      }
      else if (sess.step === "LIMP_Q2") {
        const choice = parseMenuChoice(text, 1, 6);
      
        if (!choice) {
          const attempt = incTry(sess, "LIMP_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la opción del proceso actual. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 6. (Intento ${attempt}/3)\n\n` +
              msgLimpQ2();
          }
        } else {
          resetTry(sess, "LIMP_Q2");
      
          const map = {
            1: "Sandblast",
            2: "Químicos",
            3: "Lijado manual",
            4: "Tercerizan servicio",
            5: "Limpieza con hielo seco",
            6: "No lo hemos resuelto aún",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgLimpQ2();
          } else {
            sess.data.limp_proceso_actual = val;
            sess.step = "LIMP_Q3";
            reply = msgLimpQ3();
          }
        }
      }
      else if (sess.step === "LIMP_Q3") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "LIMP_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la opción del volumen de trabajo. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgLimpQ3();
          }
        } else {
          resetTry(sess, "LIMP_Q3");
      
          const map = {
            1: "Uso continuo industrial (turnos / producción diaria)",
            2: "50–200 piezas por mes",
            3: "Uso ocasional",
            4: "Proyecto aún en análisis",
          };
      
          const val = map[choice];
          if (!val) {
            // ultra seguro
            reply = msgLimpQ3();
          } else {
            sess.data.limp_volumen = val;
            sess.step = "LIMP_Q4";
            reply = msgLimpQ4();
          }
        }
      }
      else if (sess.step === "LIMP_Q4") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "LIMP_Q4");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la etapa del proyecto. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgLimpQ4();
          }
        } else {
          resetTry(sess, "LIMP_Q4");
      
          const map = {
            1: "Prioridad inmediata",
            2: "En evaluación técnica",
            3: "Planeación este año",
            4: "Exploración sin fecha definida",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgLimpQ4();
          } else {
            sess.data.limp_etapa = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }

      // ---------- MARCADORA ----------
      else if (sess.step === "MARC_Q1") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "MARC_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el material a marcar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgMarcQ1();
          }
        } else {
          resetTry(sess, "MARC_Q1");
      
          const map = {
            1: "Acero / inoxidable",
            2: "Aluminio",
            3: "Plásticos",
            4: "Acrílico / madera",
            5: "Aún no lo defino",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgMarcQ1();
          } else {
            sess.data.marc_material = val;
            sess.step = "MARC_Q2";
            reply = msgMarcQ2();
          }
        }
      }
      else if (sess.step === "MARC_Q2") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "MARC_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el volumen de producción. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgMarcQ2();
          }
        } else {
          resetTry(sess, "MARC_Q2");
      
          const map = {
            1: "Producción continua / en línea",
            2: "100–500 piezas por mes",
            3: "Bajo pedido",
            4: "Proyecto en evaluación",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgMarcQ2();
          } else {
            sess.data.marc_volumen = val;
            sess.step = "MARC_Q3";
            reply = msgMarcQ3();
          }
        }
      }
      else if (sess.step === "MARC_Q3") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "MARC_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el proceso actual de marcado. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgMarcQ3();
          }
        } else {
          resetTry(sess, "MARC_Q3");
      
          const map = {
            1: "Grabado mecánico",
            2: "Etiquetas",
            3: "Tinta / tampografía",
            4: "Tercerizamos",
            5: "No realizamos marcado aún",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgMarcQ3();
          } else {
            sess.data.marc_proceso_actual = val;
            sess.step = "MARC_Q4";
            reply = msgMarcQ4();
          }
        }
      }
      else if (sess.step === "MARC_Q4") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "MARC_Q4");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la etapa del proyecto. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgMarcQ4();
          }
        } else {
          resetTry(sess, "MARC_Q4");
      
          const map = {
            1: "Necesidad inmediata",
            2: "Comparando proveedores",
            3: "Planeación este año",
            4: "Explorando opciones",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgMarcQ4();
          } else {
            sess.data.marc_etapa = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }

      // ---------- CORTADORA ----------
      else if (sess.step === "CORT_Q1") {
        const choice = parseMenuChoice(text, 1, 6);
      
        if (!choice) {
          const attempt = incTry(sess, "CORT_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el material a cortar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 6. (Intento ${attempt}/3)\n\n` +
              msgCortQ1();
          }
        } else {
          resetTry(sess, "CORT_Q1");
      
          const map = {
            1: "Acero al carbón",
            2: "Acero inoxidable",
            3: "Aluminio",
            4: "Lámina galvanizada",
            5: "Acrílico / MDF",
            6: "Por definir",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgCortQ1();
          } else {
            sess.data.cort_material = val;
            sess.step = "CORT_Q2";
            reply = msgCortQ2();
          }
        }
      }
      else if (sess.step === "CORT_Q2") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "CORT_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el espesor a cortar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgCortQ2();
          }
        } else {
          resetTry(sess, "CORT_Q2");
      
          const map = {
            1: "Hasta 3 mm",
            2: "3–6 mm",
            3: "6–12 mm",
            4: "Más de 12 mm",
            5: "Aún no lo tengo definido",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgCortQ2();
          } else {
            sess.data.cort_espesor = val;
            sess.step = "CORT_Q3";
            reply = msgCortQ3();
          }
        }
      }
      else if (sess.step === "CORT_Q3") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "CORT_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el volumen de producción. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgCortQ3();
          }
        } else {
          resetTry(sess, "CORT_Q3");
      
          const map = {
            1: "Producción continua / turnos diarios",
            2: "100–500 piezas por mes",
            3: "Producción bajo pedido",
            4: "Proyecto en evaluación",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgCortQ3();
          } else {
            sess.data.cort_volumen = val;
            sess.step = "CORT_Q4";
            reply = msgCortQ4();
          }
        }
      }
      else if (sess.step === "CORT_Q4") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "CORT_Q4");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el proceso actual de corte. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgCortQ4();
          }
        } else {
          resetTry(sess, "CORT_Q4");
      
          const map = {
            1: "Plasma",
            2: "Oxicorte",
            3: "Sierra / guillotina",
            4: "Tercerizan el servicio",
            5: "No lo realizamos aún",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgCortQ4();
          } else {
            sess.data.cort_proceso_actual = val;
            sess.step = "CORT_Q5";
            reply = msgCortQ5();
          }
        }
      }
      else if (sess.step === "CORT_Q5") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "CORT_Q5");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la etapa del proyecto. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgCortQ5();
          }
        } else {
          resetTry(sess, "CORT_Q5");
      
          const map = {
            1: "Necesidad inmediata",
            2: "Comparando proveedores",
            3: "Planeación este año",
            4: "Explorando opciones",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgCortQ5();
          } else {
            sess.data.cort_etapa = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }

      // ---------- SOLDADORA ----------
      else if (sess.step === "SOLD_TIPO") {
        const stepBefore = sess.step;
        const choice = parseMenuChoice(text, 1, 2);
      
        // inválido => contar intento
        if (!choice) {
          const attempt = incTry(sess, "SOLD_TIPO");
      
          if (attempt >= 3) {
            // 3er fallo => reiniciar automático
            sess = await startSession(from);
            reply =
              "No logré entender la opción de Soldadora. Reiniciamos ✅\n\n" +
              msgProducto();

            logFallback({ from, msgId, text, sess, reason: "SOLD_TIPO_MAX_TRIES" });

          } else {
            reply =
              `Responde solo con un número del 1 al 2. (Intento ${attempt}/3)\n\n` +
              msgSoldTipo();
          }
        } else {
          // válido => reset intentos de este step
          resetTry(sess, "SOLD_TIPO");
      
          const map = {
            1: "Reparación de moldes",
            2: "Soldadura de producción",
          };
      
          const val = map[choice];
          if (!val) {
            // fallback ultra seguro
            reply = msgSoldTipo();
            logFallback({ from, msgId, text, sess, reason: "SOLD_TIPO_MAP_MISS" });
          } else {
            sess.data.sold_tipo = val;
      
            if (val === "Reparación de moldes") {
              sess.step = "SOLD_MOLDES_Q1";
              reply = msgSoldMoldesQ1();
              logStep({ from, msgId, text, stepBefore, sess, note: "SOLD_TIPO->SOLD_MOLDES_Q1" });
            } else {
              sess.step = "SOLD_PROD_Q1";
              reply = msgSoldProdQ1();
              logStep({ from, msgId, text, stepBefore, sess, note: "SOLD_TIPO->SOLD_PROD_Q1" });
            }
          }
        }
      }

      // Moldes
      else if (sess.step === "SOLD_MOLDES_Q1") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_MOLDES_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la cantidad de moldes por mes. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgSoldMoldesQ1();
          }
        } else {
          resetTry(sess, "SOLD_MOLDES_Q1");
      
          const map = {
            1: "1 a 10",
            2: "10 a 20",
            3: "20 a 30",
            4: "Arriba de 30",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldMoldesQ1();
          } else {
            sess.data.sold_moldes_mes = val;
            sess.step = "SOLD_MOLDES_Q2";
            reply = msgSoldMoldesQ2();
          }
        }
      }
      else if (sess.step === "SOLD_MOLDES_Q2") {
        const choice = parseMenuChoice(text, 1, 3);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_MOLDES_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la opción de mantenimiento interno. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 3. (Intento ${attempt}/3)\n\n` +
              msgSoldMoldesQ2();
          }
        } else {
          resetTry(sess, "SOLD_MOLDES_Q2");
      
          const map = {
            1: "Sí, equipo interno",
            2: "Parcial, pero tercerizamos",
            3: "No, todo se envía a externo",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldMoldesQ2();
          } else {
            sess.data.sold_mant_interno = val;
            sess.step = "SOLD_MOLDES_Q3";
            reply = msgSoldMoldesQ3();
          }
        }
      }
      else if (sess.step === "SOLD_MOLDES_Q3") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_MOLDES_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender la etapa del proyecto. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgSoldMoldesQ3();
          }
        } else {
          resetTry(sess, "SOLD_MOLDES_Q3");
      
          const map = {
            1: "Prioridad inmediata",
            2: "En evaluación técnica",
            3: "Planeación este año",
            4: "Exploración sin fecha definida",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldMoldesQ3();
          } else {
            sess.data.sold_etapa = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }

      // Producción
      else if (sess.step === "SOLD_PROD_Q1") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_PROD_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el tipo de producto a soldar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgSoldProdQ1();
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q1");
      
          const map = {
            1: "Lámina metálica",
            2: "Tubo / Perfil",
            3: "Piezas automotrices",
            4: "Otro",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldProdQ1();
          } else {
            sess.data.sold_prod_producto = val;
      
            if (val === "Otro") {
              sess.step = "SOLD_PROD_Q1_OTRO";
              reply = msgSoldProdQ1Otro();
            } else {
              sess.step = "SOLD_PROD_Q2";
              reply = msgSoldProdQ2();
            }
          }
        }
      }
      else if (sess.step === "SOLD_PROD_Q1_OTRO") {
        const txt = String(text || "").trim();
      
        const okLen = txt.length >= 3;
        const hasLetter = /[A-Za-zÑñ]/.test(txt) || /[ÁÉÍÓÚáéíóú]/.test(txt);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "SOLD_PROD_Q1_OTRO");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar el producto a soldar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Especifica el producto a soldar (texto). Ej: Estructuras metálicas. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q1_OTRO");
          sess.data.sold_prod_producto_otro = txt;
          sess.step = "SOLD_PROD_Q2";
          reply = msgSoldProdQ2();
        }
      }
      else if (sess.step === "SOLD_PROD_Q2") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_PROD_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el material a soldar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgSoldProdQ2();
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q2");
      
          const map = {
            1: "Acero al carbón",
            2: "Acero inoxidable",
            3: "Aluminio",
            4: "Galvanizado",
            5: "Otro",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldProdQ2();
          } else {
            sess.data.sold_prod_material = val;
      
            if (val === "Otro") {
              sess.step = "SOLD_PROD_Q2_OTRO";
              reply = msgSoldProdQ2Otro();
            } else {
              sess.step = "SOLD_PROD_Q3";
              reply = msgSoldProdQ3();
            }
          }
        }
      }
      else if (sess.step === "SOLD_PROD_Q2_OTRO") {
        const txt = String(text || "").trim();
      
        const okLen = txt.length >= 3;
        const hasLetter = /[A-Za-zÑñ]/.test(txt) || /[ÁÉÍÓÚáéíóú]/.test(txt);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "SOLD_PROD_Q2_OTRO");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar el material a soldar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Especifica el material a soldar (texto). Ej: Titanio / Cobre. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q2_OTRO");
          sess.data.sold_prod_material_otro = txt;
          sess.step = "SOLD_PROD_Q3";
          reply = msgSoldProdQ3();
        }
      }
      else if (sess.step === "SOLD_PROD_Q3") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_PROD_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el espesor a soldar. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgSoldProdQ3();
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q3");
      
          const map = {
            1: "Menor a 1 mm",
            2: "1–3 mm",
            3: "3–6 mm",
            4: "Más de 6 mm",
            5: "Aún no lo tengo definido",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldProdQ3();
          } else {
            sess.data.sold_prod_espesor = val;
            sess.step = "SOLD_PROD_Q4";
            reply = msgSoldProdQ4();
          }
        }
      }
      else if (sess.step === "SOLD_PROD_Q4") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_PROD_Q4");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el proceso de soldadura actual. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgSoldProdQ4();
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q4");
      
          const map = {
            1: "MIG",
            2: "TIG",
            3: "Electrodo",
            4: "Soldadura tradicional + retrabajo",
            5: "Tercerizan el servicio",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldProdQ4();
          } else {
            sess.data.sold_prod_proceso_actual = val;
            sess.step = "SOLD_PROD_Q5";
            reply = msgSoldProdQ5();
          }
        }
      }
      else if (sess.step === "SOLD_PROD_Q5") {
        const choice = parseMenuChoice(text, 1, 4);
      
        if (!choice) {
          const attempt = incTry(sess, "SOLD_PROD_Q5");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el volumen mensual. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 4. (Intento ${attempt}/3)\n\n` +
              msgSoldProdQ5();
          }
        } else {
          resetTry(sess, "SOLD_PROD_Q5");
      
          const map = {
            1: "Producción continua (turnos diarios)",
            2: "50–200 piezas por mes",
            3: "Trabajo bajo pedido",
            4: "Proyecto en evaluación",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSoldProdQ5();
          } else {
            sess.data.sold_prod_volumen_mes = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }

      // ---------- SOPORTE ----------
      else if (sess.step === "SOP_Q1") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "SOP_Q1");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender qué equipo tienes. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgSopQ1();
          }
        } else {
          resetTry(sess, "SOP_Q1");
      
          const map = {
            1: "Limpiadora láser",
            2: "Soldadora láser",
            3: "Marcadora láser",
            4: "Cortadora láser",
            5: "Otro equipo (especificar)",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSopQ1();
          } else {
            sess.data.sop_equipo = val;
      
            if (val === "Otro equipo (especificar)") {
              sess.step = "SOP_Q1_OTRO";
              reply = msgSopQ1Otro();
            } else {
              sess.step = "SOP_Q2";
              reply = msgSopQ2();
            }
          }
        }
      }
      else if (sess.step === "SOP_Q1_OTRO") {
        const txt = String(text || "").trim();
      
        const okLen = txt.length >= 3;
        const hasLetter = /[A-Za-zÑñ]/.test(txt) || /[ÁÉÍÓÚáéíóú]/.test(txt);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "SOP_Q1_OTRO");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar el equipo. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Especifica el equipo (texto). Ej: Fuente láser / Chiller / Cabezal. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "SOP_Q1_OTRO");
          sess.data.sop_equipo_otro = txt;
          sess.step = "SOP_Q2";
          reply = msgSopQ2();
        }
      }
      else if (sess.step === "SOP_Q2") {
        const choice = parseMenuChoice(text, 1, 2);
      
        if (!choice) {
          const attempt = incTry(sess, "SOP_Q2");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender si tu máquina es FEIYANG. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 2. (Intento ${attempt}/3)\n\n` +
              msgSopQ2();
          }
        } else {
          resetTry(sess, "SOP_Q2");
      
          const map = {
            1: "Sí",
            2: "No",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSopQ2();
          } else {
            sess.data.sop_es_feiyang = val;
            sess.step = "SOP_Q3";
            reply = msgSopQ3();
          }
        }
      }
      else if (sess.step === "SOP_Q3") {
        const choice = parseMenuChoice(text, 1, 5);
      
        if (!choice) {
          const attempt = incTry(sess, "SOP_Q3");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender el tipo de apoyo. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con un número del 1 al 5. (Intento ${attempt}/3)\n\n` +
              msgSopQ3();
          }
        } else {
          resetTry(sess, "SOP_Q3");
      
          const map = {
            1: "Refacción",
            2: "Mantenimiento",
            3: "Reparación",
            4: "Capacitación",
            5: "Actualización / mejora del equipo",
          };
      
          const val = map[choice];
          if (!val) {
            reply = msgSopQ3();
          } else {
            sess.data.sop_tipo_apoyo = val;
            sess.step = "NOMBRE";
            reply = msgNombre();
          }
        }
      }
      // ---------- Contacto ----------
      else if (sess.step === "NOMBRE") {
        const nombre = String(text || "").trim();
      
        // válido si: >=3 chars y contiene letras
        const okLen = nombre.length >= 3;
        const hasLetter = /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(nombre);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "NOMBRE");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar tu nombre correctamente. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Escribe tu nombre completo (solo texto). Ej: Juan Pérez. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "NOMBRE");
          sess.data.nombre = nombre;
          sess.step = "EMPRESA";
          reply = msgEmpresa();
        }
      }
      else if (sess.step === "EMPRESA") {
        const stepBefore = sess.step;
        const empresa = String(text || "").trim();
      
        const okLen = empresa.length >= 2;
        const hasLetter = /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(empresa);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "EMPRESA");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar el nombre de tu empresa/taller. Reiniciamos ✅\n\n" +
              msgProducto();

            logFallback({ from, msgId, text, sess, reason: "EMPRESA_MAX_TRIES" });  
          } else {
            reply =
              `Escribe el nombre de tu empresa o taller (solo texto). Ej: Taller Pérez. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "EMPRESA");
          sess.data.empresa = empresa;
          sess.step = "UBICACION";
          reply = msgUbicacion();

          logStep({ from, msgId, text, stepBefore, sess, note: "EMPRESA->UBICACION" });
        }
      }
      else if (sess.step === "UBICACION") {
        const ubic = String(text || "").trim();
      
        const okLen = ubic.length >= 3;
        const hasLetter = /[A-Za-zÑñ]/.test(ubic) || /[ÁÉÍÓÚáéíóú]/.test(ubic);
      
        if (!okLen || !hasLetter) {
          const attempt = incTry(sess, "UBICACION");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar tu ubicación correctamente. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Indica tu ciudad y estado. Ej: CDMX / Monterrey, NL. (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "UBICACION");
          sess.data.ubicacion = ubic;
          sess.step = "EMAIL";
          reply = msgEmail();
        }
      }
      
      else if (sess.step === "EMAIL") {
        const email = String(text || "").trim();
      
        // válido si tiene algo@algo.algo (simple y efectivo)
        const ok =
          email.length >= 6 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      
        if (!ok) {
          const attempt = incTry(sess, "EMAIL");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré registrar tu correo correctamente. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Escribe un correo válido. Ej: nombre@dominio.com (Intento ${attempt}/3)`;
          }
        } else {
          resetTry(sess, "EMAIL");
          sess.data.email = email;
        
          // Preparamos datos, pero todavía NO cerramos
          sess.data.dentro_horario = isDentroHorarioCDMX();
          sess.data.qa_resumen = buildResumen(sess.data);
        
          // Nuevo paso final
          sess.step = "REQUIERE_HUMANO";
          reply = msgRequiereHumano();
        }
      }
      else if (sess.step === "REQUIERE_HUMANO") {
        const t = norm(text);
      
        let val = "";
        if (t === "1" || t === "si" || t === "sí") val = "Si";
        else if (t === "2" || t === "no") val = "No";
      
        if (!val) {
          const attempt = incTry(sess, "REQUIERE_HUMANO");
          if (attempt >= 3) {
            sess = await startSession(from);
            reply =
              "No logré entender tu respuesta. Reiniciamos ✅\n\n" +
              msgProducto();
          } else {
            reply =
              `Responde solo con:\n1) Si\n2) No\n\n(Intento ${attempt}/3)\n\n` +
              msgRequiereHumano();
          }
        } else {
          resetTry(sess, "REQUIERE_HUMANO");
      
          sess.data.requiere_humano = val;
      
          if (val === "Si") {
            sess.data.motivo_atencion = "Solicita asesor humano al finalizar cuestionario";
            sess.data.ultimo_mensaje_cliente = "Responde Sí a contacto humano";
          } else {
            sess.data.motivo_atencion = "";
            sess.data.ultimo_mensaje_cliente = "";
          }
      
          completed = true;
          sess.step = "COMPLETED";
      
          const d = sess.data;
      
          const cierre =
            d.requiere_humano === "Si"
              ? (
                  d.dentro_horario
                    ? "👨‍💼 Un asesor especializado se pondrá en contacto contigo a la brevedad posible para ayudarte con tu solicitud.\n¡Gracias por escribirnos!"
                    : "🕒 Hemos recibido tu información correctamente.\nNuestro equipo te contactará en el próximo horario laboral (lunes a viernes de 9:00 a 18:00).\n¡Gracias por tu interés!"
                )
              : "Perfecto. Hemos registrado tu información.\nSi más adelante necesitas apoyo, escríbenos y con gusto te ayudamos.";
      
          reply =
            "¡Gracias! Hemos registrado tus datos:\n\n" +
            `• Producto: ${d.producto_interes_v2 || d.producto_interes || ""}\n` +
            `• Nombre: ${d.nombre || ""}\n` +
            `• Empresa: ${d.empresa || ""}\n` +
            `• Ubicación: ${d.ubicacion || ""}\n` +
            `• Email: ${d.email || ""}\n` +
            `• Requiere asesor humano: ${d.requiere_humano || ""}\n\n` +
            cierre +
            "\n\n(Escribe 'menu' para reiniciar)";
        }
      }


      else {
        // si por algo quedó raro, reinicia
        logFallback({ from, msgId, text, sess, reason: "UNKNOWN_STEP" });
        sess = await startSession(from);
        reply = msgProducto();
      }

      // ======= Responder WhatsApp (rápido) =======
      await sendWhatsAppText(waUrl, waToken, from, reply);

      if (!completed && sess) {
        await saveSession(from, sess);
      }

      // ======= Guardar en Lark SOLO al finalizar (después de WhatsApp) =======
      if (completed) {
        try {
          const d = sess.data;

          logSaveLark({ from, msgId, sess });

          await larkCreateLead({
            wa_id: String(from),
            created_at_ms: Date.now(),

            // legacy (por compatibilidad; pueden quedar vacíos)
            sucursal: d.sucursal || "",
            producto_interes: d.producto_interes || "",
            intencion_cliente: d.intencion_cliente || "",

            // nuevos generales
            producto_interes_v2: d.producto_interes_v2 || "",
            qa_resumen: d.qa_resumen || "",
            dentro_horario: !!d.dentro_horario,
            requiere_humano: d.requiere_humano || "",
            motivo_atencion: d.motivo_atencion || "",
            ultimo_mensaje_cliente: d.ultimo_mensaje_cliente || "",
            whatsapp_link: `https://wa.me/${from}`,

            // limpiadora
            limp_que_limpia: d.limp_que_limpia || "",
            limp_proceso_actual: d.limp_proceso_actual || "",
            limp_volumen: d.limp_volumen || "",
            limp_etapa: d.limp_etapa || "",

            // marcadora
            marc_material: d.marc_material || "",
            marc_volumen: d.marc_volumen || "",
            marc_proceso_actual: d.marc_proceso_actual || "",
            marc_etapa: d.marc_etapa || "",

            // cortadora
            cort_material: d.cort_material || "",
            cort_espesor: d.cort_espesor || "",
            cort_volumen: d.cort_volumen || "",
            cort_proceso_actual: d.cort_proceso_actual || "",
            cort_etapa: d.cort_etapa || "",

            // soldadora
            sold_tipo: d.sold_tipo || "",
            sold_moldes_mes: d.sold_moldes_mes || "",
            sold_mant_interno: d.sold_mant_interno || "",
            sold_etapa: d.sold_etapa || "",
            sold_prod_producto: d.sold_prod_producto || "",
            sold_prod_producto_otro: d.sold_prod_producto_otro || "",
            sold_prod_material: d.sold_prod_material || "",
            sold_prod_material_otro: d.sold_prod_material_otro || "",
            sold_prod_espesor: d.sold_prod_espesor || "",
            sold_prod_proceso_actual: d.sold_prod_proceso_actual || "",
            sold_prod_volumen_mes: d.sold_prod_volumen_mes || "",

            // soporte
            sop_equipo: d.sop_equipo || "",
            sop_equipo_otro: d.sop_equipo_otro || "",
            sop_es_feiyang: d.sop_es_feiyang || "",
            sop_tipo_apoyo: d.sop_tipo_apoyo || "",

            // contacto
            nombre: d.nombre || "",
            empresa: d.empresa || "",
            ubicacion: d.ubicacion || "",
            telefono: "",
            email: d.email || "",
            mensaje: "", // opcional
            stage: "COMPLETED",
          });

          console.log("LARK_SYNC_OK");
        } catch (e) {
          console.error("LARK_SYNC_ERROR:", e?.message || e);
        } finally {
          sess.handoffHuman = true;
          sess.step = "HUMAN_HANDOFF";
          sess.tries = {};
          sess.updatedAt = Date.now();
        
          await saveSession(from, sess);
        
          console.log("[HANDOFF_HUMAN_SET]", JSON.stringify({
            from,
            msgId,
            step_after: sess.step,
            producto_interes_v2: sess?.data?.producto_interes_v2 || sess?.data?.producto_interes || null,
          }));
        }
      }

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err?.message || err);
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
};

// =========================
// WhatsApp helper
// =========================
async function sendWhatsAppText(waUrl, waToken, to, bodyText) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: String(bodyText || "") },
  };

  const resp = await fetch(waUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${waToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));
  return { status: resp.status, data };
}

// =========================
// LARK HELPERS (solo CREATE + lectura de fields para tipado)
// =========================

async function larkGetTenantToken() {
  const now = Date.now();
  if (LARK_CACHE.token && LARK_CACHE.expiresAtMs > now + 60000) return LARK_CACHE.token;

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET");

  const url = "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.tenant_access_token) {
    throw new Error(`Lark token error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  const expireSec = Number(data?.expire || 3600);
  LARK_CACHE.token = data.tenant_access_token;
  LARK_CACHE.expiresAtMs = Date.now() + expireSec * 1000;
  return LARK_CACHE.token;
}

// Trae metadata de fields (para saber si un campo es Select / Date / Text, etc.)
async function larkGetFieldsByName(appToken, tableId) {
  const now = Date.now();
  if (LARK_FIELDS_CACHE.byName && (now - (LARK_FIELDS_CACHE.loadedAtMs || 0)) < LARK_FIELDS_TTL_MS) {
    return LARK_FIELDS_CACHE.byName;
  }

  const tenantToken = await larkGetTenantToken();
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=200`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${tenantToken}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark list fields error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  const items = data?.data?.items || [];
  const byName = {};
  for (const f of items) {
    if (f?.field_name) byName[f.field_name] = f;
  }

  LARK_FIELDS_CACHE.byName = byName;
  LARK_FIELDS_CACHE.loadedAtMs = Date.now();
  return byName;
}

function pickSelectOptionId(fieldMeta, desiredText) {
  const opts = fieldMeta?.property?.options;
  if (!Array.isArray(opts)) return null;

  const want = String(desiredText || "").trim().toLowerCase();
  if (!want) return null;

  const hit = opts.find(o => String(o?.name || "").trim().toLowerCase() === want);
  return hit?.id || null;
}

function toYYYYMMDD(ms) {
  const d = new Date(Number(ms || Date.now()));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Decide si un campo de fecha parece DATE o DATETIME según su formatter
function dateFieldWantsDatetime(fieldMeta) {
  const fmt = String(fieldMeta?.property?.date_formatter || fieldMeta?.property?.formatter || "");
  const f = fmt.toLowerCase();
  // heurística: si incluye hora/minutos o ":" => datetime
  return f.includes("hh") || f.includes("mm") || f.includes(":") || f.includes("ss");
}

// Coerción segura por metadata (evita TextFieldConvFail y DatetimeFieldConvFail)
function coerceToLarkValue(fieldMeta, rawValue, fieldNameForLog) {
  if (rawValue === undefined) return undefined;

  // Si el campo no existe en metadata, no lo mandamos (evita fallos por nombres)
  if (!fieldMeta) return undefined;

  // Checkbox: Lark suele aceptar boolean
  // (según SDK/metadata, puede venir como field_type o type)
  if (fieldMeta?.field_type === 7 || fieldMeta?.type === 7) {
    return !!rawValue;
  }

  
if (Array.isArray(fieldMeta?.property?.options)) {
  const label = String(rawValue ?? "").trim();
  if (!label) return undefined;

  const opts = fieldMeta.property.options || [];
  const hit = opts.find(o => String(o?.name || "").trim().toLowerCase() === label.toLowerCase());

  if (!hit) {
    console.log("LARK_SELECT_NO_MATCH:", {
      field: fieldNameForLog,
      value: label,
      options: opts.map(o => o?.name).slice(0, 50),
    });
    return undefined;
  }

  return hit.name; // manda el texto exacto (label)
}

  


  // FECHA / DATETIME: property.date_formatter suele existir
  if (fieldMeta?.property?.date_formatter || fieldMeta?.property?.formatter) {
    const wantsDatetime = dateFieldWantsDatetime(fieldMeta);
    if (wantsDatetime) {
      // Lark suele aceptar unix ms en datetime
      return Number(rawValue || Date.now());
    }
    // Date-only: enviar "YYYY-MM-DD"
    const ms = Number(rawValue || Date.now());
    return toYYYYMMDD(ms);
  }

  // Default: texto
  if (rawValue === null) return "";
  return String(rawValue);
}

async function larkCreateLead({
  wa_id,
  created_at_ms,

  // legacy
  sucursal,
  producto_interes,
  intencion_cliente,

  // nuevos generales
  producto_interes_v2,
  qa_resumen,
  dentro_horario,
  requiere_humano,
  motivo_atencion,
  ultimo_mensaje_cliente,
  whatsapp_link,

  // limpiadora
  limp_que_limpia,
  limp_proceso_actual,
  limp_volumen,
  limp_etapa,

  // marcadora
  marc_material,
  marc_volumen,
  marc_proceso_actual,
  marc_etapa,

  // cortadora
  cort_material,
  cort_espesor,
  cort_volumen,
  cort_proceso_actual,
  cort_etapa,

  // soldadora
  sold_tipo,
  sold_moldes_mes,
  sold_mant_interno,
  sold_etapa,
  sold_prod_producto,
  sold_prod_producto_otro,
  sold_prod_material,
  sold_prod_material_otro,
  sold_prod_espesor,
  sold_prod_proceso_actual,
  sold_prod_volumen_mes,

  // soporte
  sop_equipo,
  sop_equipo_otro,
  sop_es_feiyang,
  sop_tipo_apoyo,

  // contacto
  nombre,
  empresa,
  ubicacion,
  telefono,
  email,
  mensaje,
  stage,
}) {
  const appTokenRaw = process.env.LARK_APP_TOKEN;
  const tableId = process.env.LARK_TABLE_ID;

  if (!appTokenRaw || !tableId) throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID");

  const appToken = String(appTokenRaw).split("?")[0].trim();
  const tenantToken = await larkGetTenantToken();
  const fieldsByName = await larkGetFieldsByName(appToken, tableId);

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const raw = {
    wa_id,
    created_at: created_at_ms,

    // legacy
    sucursal,
    producto_interes,
    intencion_cliente,

    // nuevos generales
    producto_interes_v2,
    qa_resumen,
    dentro_horario,
    requiere_humano,
    motivo_atencion,
    ultimo_mensaje_cliente,
    whatsapp_link,

    // limpiadora
    limp_que_limpia,
    limp_proceso_actual,
    limp_volumen,
    limp_etapa,

    // marcadora
    marc_material,
    marc_volumen,
    marc_proceso_actual,
    marc_etapa,

    // cortadora
    cort_material,
    cort_espesor,
    cort_volumen,
    cort_proceso_actual,
    cort_etapa,

    // soldadora
    sold_tipo,
    sold_moldes_mes,
    sold_mant_interno,
    sold_etapa,
    sold_prod_producto,
    sold_prod_producto_otro,
    sold_prod_material,
    sold_prod_material_otro,
    sold_prod_espesor,
    sold_prod_proceso_actual,
    sold_prod_volumen_mes,

    // soporte
    sop_equipo,
    sop_equipo_otro,
    sop_es_feiyang,
    sop_tipo_apoyo,

    // contacto
    nombre,
    empresa,
    ubicacion,
    telefono,
    email,
    mensaje,

    stage: stage || "COMPLETED",
    lark_status: "OK",
    lark_synced_at: Date.now(),
    lark_error: "",
  };

  // Construimos fields SOLO con columnas que existan y con tipo correcto
  const fields = {};
  for (const [k, v] of Object.entries(raw)) {
    const meta = fieldsByName[k];
    const coerced = coerceToLarkValue(meta, v, k);
    if (coerced !== undefined) fields[k] = coerced;
  }

  console.log("LARK_FIELDS_PAYLOAD_KEYS:", Object.keys(fields));

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark create record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  console.log("LARK_SAVED:", JSON.stringify(data, null, 2));
  return data;
}