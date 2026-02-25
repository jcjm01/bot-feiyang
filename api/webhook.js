// api/webhook.js (Vercel - CommonJS)
// WhatsApp -> Node (cuestionarios por producto) -> (Lark create record al finalizar) -> Reply WhatsApp

let LARK_CACHE = { token: null, expiresAtMs: 0 };

// Cache de metadata de fields para:
// - Convertir selects a option_id
// - Formatear fechas según el tipo real del campo
let LARK_FIELDS_CACHE = { byName: null, loadedAtMs: 0 };
const LARK_FIELDS_TTL_MS = 15 * 60 * 1000; // 1 hora cache por instancia

// dedupe simple en memoria (sirve por instancia)
const SEEN = new Map(); // msgId -> expiresAt
const SEEN_TTL_MS = 5 * 60 * 1000;

// estado en memoria por wa_id (para pruebas). En serverless puede resetear si cambia instancia.
const SESS = new Map(); // wa_id -> { step, data, updatedAt }
const SESS_TTL_MS = 30 * 60 * 1000;

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function cleanupMaps() {
  const now = Date.now();
  for (const [k, exp] of SEEN) if (exp <= now) SEEN.delete(k);
  for (const [wa, sess] of SESS) if ((sess?.updatedAt || 0) + SESS_TTL_MS <= now) SESS.delete(wa);
}

function startSession(wa) {
  // Ya NO usamos sucursal: arrancamos directo en PRODUCTO
  const sess = { step: "PRODUCTO", data: {}, updatedAt: Date.now() };
  SESS.set(wa, sess);
  return sess;
}

function getSession(wa) {
  const sess = SESS.get(wa);
  if (!sess) return null;
  sess.updatedAt = Date.now();
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
      const now = Date.now();
      if (msgId && SEEN.has(msgId)) {
        console.log("DEDUP_SKIP:", msgId);
        return send(200, "OK");
      }
      if (msgId) SEEN.set(msgId, now + SEEN_TTL_MS);

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
        const sess = startSession(from);
        sess.updatedAt = Date.now();

        await sendWhatsAppText(waUrl, waToken, from, msgProducto());
        return send(200, "OK");
      }

      // obtener sesión o iniciar
      let sess = getSession(from);
      if (!sess) sess = startSession(from);

      let reply = "";
      let completed = false;

      // ======= Máquina de estados =======
      if (sess.step === "PRODUCTO") {
        let prod = "";
        if (t === "1") prod = "Limpiadora láser";
        else if (t === "2") prod = "Soldadora láser";
        else if (t === "3") prod = "Marcadora láser";
        else if (t === "4") prod = "Cortadora láser";
        else if (t === "5") prod = "Refacción / soporte técnico";

        if (!prod) {
          reply = msgProducto();
        } else {
          // compatibilidad (viejo) + nuevo
          sess.data.producto_interes = prod;
          sess.data.producto_interes_v2 = prod;

          if (prod === "Limpiadora láser") {
            sess.step = "LIMP_Q1";
            reply = msgLimpQ1();
          } else if (prod === "Marcadora láser") {
            sess.step = "MARC_Q1";
            reply = msgMarcQ1();
          } else if (prod === "Cortadora láser") {
            sess.step = "CORT_Q1";
            reply = msgCortQ1();
          } else if (prod === "Soldadora láser") {
            sess.step = "SOLD_TIPO";
            reply = msgSoldTipo();
          } else if (prod === "Refacción / soporte técnico") {
            sess.step = "SOP_Q1";
            reply = msgSopQ1();
          } else {
            // fallback
            reply = msgProducto();
          }
        }
      }

      // ---------- LIMPIADORA ----------
      else if (sess.step === "LIMP_Q1") {
        const map = {
          "1": "Remoción de óxido en estructuras metálicas",
          "2": "Limpieza de moldes o piezas industriales",
          "3": "Mantenimiento eléctrico / torres / altura",
          "4": "Remoción de pintura o recubrimientos",
          "5": "Estoy evaluando tecnología para mi empresa",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgLimpQ1();
        else {
          sess.data.limp_que_limpia = val;
          sess.step = "LIMP_Q2";
          reply = msgLimpQ2();
        }
      }
      else if (sess.step === "LIMP_Q2") {
        const map = {
          "1": "Sandblast",
          "2": "Químicos",
          "3": "Lijado manual",
          "4": "Tercerizan servicio",
          "5": "Limpieza con hielo seco",
          "6": "No lo hemos resuelto aún",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgLimpQ2();
        else {
          sess.data.limp_proceso_actual = val;
          sess.step = "LIMP_Q3";
          reply = msgLimpQ3();
        }
      }
      else if (sess.step === "LIMP_Q3") {
        const map = {
          "1": "Uso continuo industrial (turnos / producción diaria)",
          "2": "50–200 piezas por mes",
          "3": "Uso ocasional",
          "4": "Proyecto aún en análisis",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgLimpQ3();
        else {
          sess.data.limp_volumen = val;
          sess.step = "LIMP_Q4";
          reply = msgLimpQ4();
        }
      }
      else if (sess.step === "LIMP_Q4") {
        const map = {
          "1": "Prioridad inmediata",
          "2": "En evaluación técnica",
          "3": "Planeación este año",
          "4": "Exploración sin fecha definida",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgLimpQ4();
        else {
          sess.data.limp_etapa = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // ---------- MARCADORA ----------
      else if (sess.step === "MARC_Q1") {
        const map = {
          "1": "Acero / inoxidable",
          "2": "Aluminio",
          "3": "Plásticos",
          "4": "Acrílico / madera",
          "5": "Aún no lo defino",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgMarcQ1();
        else {
          sess.data.marc_material = val;
          sess.step = "MARC_Q2";
          reply = msgMarcQ2();
        }
      }
      else if (sess.step === "MARC_Q2") {
        const map = {
          "1": "Producción continua / en línea",
          "2": "100–500 piezas por mes",
          "3": "Bajo pedido",
          "4": "Proyecto en evaluación",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgMarcQ2();
        else {
          sess.data.marc_volumen = val;
          sess.step = "MARC_Q3";
          reply = msgMarcQ3();
        }
      }
      else if (sess.step === "MARC_Q3") {
        const map = {
          "1": "Grabado mecánico",
          "2": "Etiquetas",
          "3": "Tinta / tampografía",
          "4": "Tercerizamos",
          "5": "No realizamos marcado aún",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgMarcQ3();
        else {
          sess.data.marc_proceso_actual = val;
          sess.step = "MARC_Q4";
          reply = msgMarcQ4();
        }
      }
      else if (sess.step === "MARC_Q4") {
        const map = {
          "1": "Necesidad inmediata",
          "2": "Comparando proveedores",
          "3": "Planeación este año",
          "4": "Explorando opciones",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgMarcQ4();
        else {
          sess.data.marc_etapa = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // ---------- CORTADORA ----------
      else if (sess.step === "CORT_Q1") {
        const map = {
          "1": "Acero al carbón",
          "2": "Acero inoxidable",
          "3": "Aluminio",
          "4": "Lámina galvanizada",
          "5": "Acrílico / MDF",
          "6": "Por definir",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgCortQ1();
        else {
          sess.data.cort_material = val;
          sess.step = "CORT_Q2";
          reply = msgCortQ2();
        }
      }
      else if (sess.step === "CORT_Q2") {
        const map = {
          "1": "Hasta 3 mm",
          "2": "3–6 mm",
          "3": "6–12 mm",
          "4": "Más de 12 mm",
          "5": "Aún no lo tengo definido",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgCortQ2();
        else {
          sess.data.cort_espesor = val;
          sess.step = "CORT_Q3";
          reply = msgCortQ3();
        }
      }
      else if (sess.step === "CORT_Q3") {
        const map = {
          "1": "Producción continua / turnos diarios",
          "2": "100–500 piezas por mes",
          "3": "Producción bajo pedido",
          "4": "Proyecto en evaluación",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgCortQ3();
        else {
          sess.data.cort_volumen = val;
          sess.step = "CORT_Q4";
          reply = msgCortQ4();
        }
      }
      else if (sess.step === "CORT_Q4") {
        const map = {
          "1": "Plasma",
          "2": "Oxicorte",
          "3": "Sierra / guillotina",
          "4": "Tercerizan el servicio",
          "5": "No lo realizamos aún",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgCortQ4();
        else {
          sess.data.cort_proceso_actual = val;
          sess.step = "CORT_Q5";
          reply = msgCortQ5();
        }
      }
      else if (sess.step === "CORT_Q5") {
        const map = {
          "1": "Necesidad inmediata",
          "2": "Comparando proveedores",
          "3": "Planeación este año",
          "4": "Explorando opciones",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgCortQ5();
        else {
          sess.data.cort_etapa = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // ---------- SOLDADORA ----------
      else if (sess.step === "SOLD_TIPO") {
        const map = { "1": "Reparación de moldes", "2": "Soldadura de producción" };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldTipo();
        else {
          sess.data.sold_tipo = val;
          if (val === "Reparación de moldes") {
            sess.step = "SOLD_MOLDES_Q1";
            reply = msgSoldMoldesQ1();
          } else {
            sess.step = "SOLD_PROD_Q1";
            reply = msgSoldProdQ1();
          }
        }
      }

      // Moldes
      else if (sess.step === "SOLD_MOLDES_Q1") {
        const map = { "1": "1 a 10", "2": "10 a 20", "3": "20 a 30", "4": "Arriba de 30" };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldMoldesQ1();
        else {
          sess.data.sold_moldes_mes = val;
          sess.step = "SOLD_MOLDES_Q2";
          reply = msgSoldMoldesQ2();
        }
      }
      else if (sess.step === "SOLD_MOLDES_Q2") {
        const map = {
          "1": "Sí, equipo interno",
          "2": "Parcial, pero tercerizamos",
          "3": "No, todo se envía a externo",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldMoldesQ2();
        else {
          sess.data.sold_mant_interno = val;
          sess.step = "SOLD_MOLDES_Q3";
          reply = msgSoldMoldesQ3();
        }
      }
      else if (sess.step === "SOLD_MOLDES_Q3") {
        const map = {
          "1": "Prioridad inmediata",
          "2": "En evaluación técnica",
          "3": "Planeación este año",
          "4": "Exploración sin fecha definida",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldMoldesQ3();
        else {
          sess.data.sold_etapa = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // Producción
      else if (sess.step === "SOLD_PROD_Q1") {
        const map = {
          "1": "Lámina metálica",
          "2": "Tubo / Perfil",
          "3": "Piezas automotrices",
          "4": "Otro",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldProdQ1();
        else {
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
      else if (sess.step === "SOLD_PROD_Q1_OTRO") {
        sess.data.sold_prod_producto_otro = String(text || "").trim();
        sess.step = "SOLD_PROD_Q2";
        reply = msgSoldProdQ2();
      }
      else if (sess.step === "SOLD_PROD_Q2") {
        const map = {
          "1": "Acero al carbón",
          "2": "Acero inoxidable",
          "3": "Aluminio",
          "4": "Galvanizado",
          "5": "Otro",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldProdQ2();
        else {
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
      else if (sess.step === "SOLD_PROD_Q2_OTRO") {
        sess.data.sold_prod_material_otro = String(text || "").trim();
        sess.step = "SOLD_PROD_Q3";
        reply = msgSoldProdQ3();
      }
      else if (sess.step === "SOLD_PROD_Q3") {
        const map = {
          "1": "Menor a 1 mm",
          "2": "1–3 mm",
          "3": "3–6 mm",
          "4": "Más de 6 mm",
          "5": "Aún no lo tengo definido",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldProdQ3();
        else {
          sess.data.sold_prod_espesor = val;
          sess.step = "SOLD_PROD_Q4";
          reply = msgSoldProdQ4();
        }
      }
      else if (sess.step === "SOLD_PROD_Q4") {
        const map = {
          "1": "MIG",
          "2": "TIG",
          "3": "Electrodo",
          "4": "Soldadura tradicional + retrabajo",
          "5": "Tercerizan el servicio",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldProdQ4();
        else {
          sess.data.sold_prod_proceso_actual = val;
          sess.step = "SOLD_PROD_Q5";
          reply = msgSoldProdQ5();
        }
      }
      else if (sess.step === "SOLD_PROD_Q5") {
        const map = {
          "1": "Producción continua (turnos diarios)",
          "2": "50–200 piezas por mes",
          "3": "Trabajo bajo pedido",
          "4": "Proyecto en evaluación",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSoldProdQ5();
        else {
          sess.data.sold_prod_volumen_mes = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // ---------- SOPORTE ----------
      else if (sess.step === "SOP_Q1") {
        const map = {
          "1": "Limpiadora láser",
          "2": "Soldadora láser",
          "3": "Marcadora láser",
          "4": "Cortadora láser",
          "5": "Otro equipo (especificar)",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSopQ1();
        else {
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
      else if (sess.step === "SOP_Q1_OTRO") {
        sess.data.sop_equipo_otro = String(text || "").trim();
        sess.step = "SOP_Q2";
        reply = msgSopQ2();
      }
      else if (sess.step === "SOP_Q2") {
        const map = { "1": "Sí", "2": "No" };
        const val = pickOption(text, map);
        if (!val) reply = msgSopQ2();
        else {
          sess.data.sop_es_feiyang = val;
          sess.step = "SOP_Q3";
          reply = msgSopQ3();
        }
      }
      else if (sess.step === "SOP_Q3") {
        const map = {
          "1": "Refacción",
          "2": "Mantenimiento",
          "3": "Reparación",
          "4": "Capacitación",
          "5": "Actualización / mejora del equipo",
        };
        const val = pickOption(text, map);
        if (!val) reply = msgSopQ3();
        else {
          sess.data.sop_tipo_apoyo = val;
          sess.step = "NOMBRE";
          reply = msgNombre();
        }
      }

      // ---------- Contacto ----------
      else if (sess.step === "NOMBRE") {
        sess.data.nombre = String(text || "").trim();
        sess.step = "EMPRESA";
        reply = msgEmpresa();
      }
      else if (sess.step === "EMPRESA") {
        sess.data.empresa = String(text || "").trim();
        sess.step = "UBICACION";
        reply = msgUbicacion();
      }
      else if (sess.step === "UBICACION") {
        sess.data.ubicacion = String(text || "").trim();
        sess.step = "EMAIL";
        reply = msgEmail();
      }
      
      else if (sess.step === "EMAIL") {
        sess.data.email = String(text || "").trim();

        // final
        completed = true;
        sess.step = "COMPLETED";

        const d = sess.data;
        d.dentro_horario = isDentroHorarioCDMX();
        d.qa_resumen = buildResumen(d);

        const cierre = d.dentro_horario
          ? "✅ Un asesor especializado se pondrá en contacto contigo a la brevedad posible.\n¡Gracias por escribirnos!"
          : "🕘 Hemos recibido tu información correctamente.\nNuestro equipo te contactará en el próximo horario laboral (lunes a viernes de 9:00 a 18:00).\n¡Gracias por tu interés!";

        reply =
`¡Gracias! Hemos registrado tus datos:
- Producto: ${d.producto_interes_v2 || d.producto_interes || ""}
- Nombre: ${d.nombre || ""}
- Empresa: ${d.empresa || ""}
- Ubicación: ${d.ubicacion || ""}
- Email: ${d.email || ""}

${cierre}

(Escribe 'menu' para reiniciar)`;
      }
      else {
        // si por algo quedó raro, reinicia
        sess = startSession(from);
        reply = msgProducto();
      }

      // ======= Responder WhatsApp (rápido) =======
      await sendWhatsAppText(waUrl, waToken, from, reply);

      // ======= Guardar en Lark SOLO al finalizar (después de WhatsApp) =======
      if (completed) {
        try {
          const d = sess.data;

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
          // limpia sesión para que no repita
          SESS.delete(from);
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

  // SELECT (single/multi): property.options existe
  // SELECT (single/multi): property.options existe
if (Array.isArray(fieldMeta?.property?.options)) {
  const optId = pickSelectOptionId(fieldMeta, rawValue);
  if (!optId) {
    console.log("LARK_SELECT_NO_MATCH:", {
      field: fieldNameForLog,
      value: String(rawValue || ""),
      options: (fieldMeta.property.options || []).map(o => o?.name).slice(0, 50),
    });
    return undefined;
  }

  // IMPORTANT: enviar formato estructurado para que Lark lo renderice bien
  // Single Option -> { id: "opt..." }
  // Multiple Option -> [{ id: "opt..." }, ...]
  const ft = fieldMeta?.field_type ?? fieldMeta?.type;

  // Nota: si tu tenant usa otros códigos, esto sigue siendo seguro:
  // si resulta ser multi y mandamos objeto, fallará y lo veremos en logs.
  // pero normalmente:
  // - single select: objeto {id}
  // - multi select: array de objetos [{id}]
  const looksMulti = ft === 4 || ft === 23; // (depende del tenant; si no aplica lo ajustamos con logs)
  if (looksMulti) return [{ id: optId }];
  return { id: optId };
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