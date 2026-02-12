// api/webhook.js (Vercel - CommonJS)
// WhatsApp -> Node (cuestionario rápido) -> (Lark create record al finalizar) -> Reply WhatsApp

let LARK_CACHE = { token: null, expiresAtMs: 0 };

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
  const sess = { step: "SUCURSAL", data: {}, updatedAt: Date.now() };
  SESS.set(wa, sess);
  return sess;
}

function getSession(wa) {
  const sess = SESS.get(wa);
  if (!sess) return null;
  sess.updatedAt = Date.now();
  return sess;
}

// ====== Preguntas (mismo estilo que tu screenshot) ======
function msgSucursal() {
  return (
`Listo. Reiniciamos tu solicitud.

¿Con qué sucursal quieres continuar?

1) CDMX
2) Monterrey

Responde 1 o 2 (o escribe CDMX / MTY).`
  );
}

function msgProducto() {
  return (
`Hola, gracias por contactar a FEIYANG MAQUINARIA.
Por favor selecciona una opción escribiendo el número:

1) Limpiadoras láser
2) Soldadoras láser
3) Marcadoras láser
4) Otro`
  );
}

function msgIntencion() {
  return (
`Perfecto.
¿Qué te gustaría hacer?

1) Solicitar una cotización
2) Solicitar una DEMO
3) Recibir más información`
  );
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
      const phoneNumberId = value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;

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

        await sendWhatsAppText(waUrl, waToken, from, msgSucursal());
        return send(200, "OK");
      }

      // obtener sesión o iniciar
      let sess = getSession(from);
      if (!sess) sess = startSession(from);

      let reply = "";
      let completed = false;

      // ======= Máquina de estados =======
      if (sess.step === "SUCURSAL") {
        let suc = "";
        if (t === "1" || t.includes("cdmx")) suc = "CDMX";
        else if (t === "2" || t.includes("mty") || t.includes("monterrey")) suc = "MTY";

        if (!suc) {
          reply = msgSucursal();
        } else {
          sess.data.sucursal = suc;
          sess.step = "PRODUCTO";
          reply = `Perfecto ✅ Sucursal: ${suc}\n\n` + msgProducto();
        }
      }

      else if (sess.step === "PRODUCTO") {
        let prod = "";
        if (t === "1") prod = "Limpiadoras láser";
        else if (t === "2") prod = "Soldadoras láser";
        else if (t === "3") prod = "Marcadoras láser";
        else if (t === "4" || t.includes("otro")) prod = "Otro";

        if (!prod) {
          reply = msgProducto();
        } else {
          sess.data.producto_interes = prod;
          sess.step = "INTENCION";
          reply = msgIntencion();
        }
      }

      else if (sess.step === "INTENCION") {
        let intent = "";
        if (t === "1") intent = "Cotización";
        else if (t === "2") intent = "DEMO";
        else if (t === "3") intent = "Más información";

        if (!intent) {
          reply = msgIntencion();
        } else {
          sess.data.intencion_cliente = intent;
          sess.step = "NOMBRE";
          reply = "Excelente elección.\nPara continuar, ¿podrías indicarnos tu nombre completo?";
        }
      }

      else if (sess.step === "NOMBRE") {
        sess.data.nombre = String(text || "").trim();
        sess.step = "EMPRESA";
        reply = "Gracias. ¿Cuál es el nombre de tu empresa o taller?";
      }

      else if (sess.step === "EMPRESA") {
        sess.data.empresa = String(text || "").trim();
        sess.step = "UBICACION";
        reply = "¿En qué ciudad y estado te encuentras?";
      }

      else if (sess.step === "UBICACION") {
        sess.data.ubicacion = String(text || "").trim();
        sess.step = "TELEFONO";
        reply = "¿Cuál es tu número de teléfono para contactarte?";
      }

      else if (sess.step === "TELEFONO") {
        sess.data.telefono = String(text || "").trim();
        sess.step = "EMAIL";
        reply = "Por último, ¿nos compartes tu correo electrónico?";
      }

      else if (sess.step === "EMAIL") {
        sess.data.email = String(text || "").trim();

        // final
        completed = true;
        sess.step = "COMPLETED";

        const d = sess.data;
        reply =
`¡Gracias! Hemos registrado tus datos:
Sucursal: ${d.sucursal || ""}
- Producto: ${d.producto_interes || ""}
- Intención: ${d.intencion_cliente || ""}
- Nombre: ${d.nombre || ""}
- Empresa: ${d.empresa || ""}
- Ubicación: ${d.ubicacion || ""}
- Teléfono: ${d.telefono || ""}
- Email: ${d.email || ""}

En breve un asesor se pondrá en contacto contigo.
(Escribe 'menu' para reiniciar)`;
      }

      else {
        // si por algo quedó raro, reinicia
        sess = startSession(from);
        reply = msgSucursal();
      }

      // ======= Responder WhatsApp (rápido) =======
      await sendWhatsAppText(waUrl, waToken, from, reply);

      // ======= Guardar en Lark SOLO al finalizar (SIN LIST/FILTER) =======
      if (completed) {
        try {
          const d = sess.data;

          await larkCreateLead({
            wa_id: String(from),
            created_at_ms: Date.now(),
            sucursal: d.sucursal || "",
            producto_interes: d.producto_interes || "",
            intencion_cliente: d.intencion_cliente || "",
            nombre: d.nombre || "",
            empresa: d.empresa || "",
            ubicacion: d.ubicacion || "",
            telefono: d.telefono || "",
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
// LARK HELPERS (solo CREATE, sin list/filter)
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

async function larkCreateLead({
  wa_id,
  created_at_ms,
  sucursal,
  producto_interes,
  intencion_cliente,
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

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  // OJO: usamos exactamente los nombres de columna que tú mostraste en Lark
const createdAt = new Date(created_at_ms || Date.now());
const createdAtYYYYMMDD = createdAt.toISOString().slice(0, 10); // "2026-02-12"

const syncedAt = new Date();
const syncedAtYYYYMMDD = syncedAt.toISOString().slice(0, 10);

  const fields = {
    wa_id: String(wa_id || ""),
    created_at: Number(created_at_ms || Date.now()),
    sucursal: String(sucursal || ""),
    producto_interes: String(producto_interes || ""),
    intencion_cliente: String(intencion_cliente || ""),
    nombre: String(nombre || ""),
    empresa: String(empresa || ""),
    ubicacion: String(ubicacion || ""),
    telefono: String(telefono || ""),
    email: String(email || ""),
    mensaje: String(mensaje || ""),
    stage: String(stage || "COMPLETED"),
    lark_status: "OK",
    lark_synced_at: Number(Date.now()),
    lark_error: "",
  };

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
