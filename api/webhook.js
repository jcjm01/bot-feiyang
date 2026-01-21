// api/webhook.js
// WhatsApp Cloud API Webhook (Vercel)
// - GET: verificación (hub.challenge)
// - POST: recibe mensajes, guarda/actualiza en Lark Bitable y responde con flujo

let LARK_CACHE = { token: null, expiresAtMs: 0 };

export default async function handler(req, res) {
  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  };

  const readJsonBody = async (req) => {
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

  // 1) Verificación (GET)
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return send(200, String(challenge || ""));
    }
    return send(403, "Forbidden");
  }

  // 2) Eventos (POST)
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];
      if (!msg) return send(200, "OK");

      const from = msg?.from;
      const text = (msg?.text?.body || "").trim();
      const phoneNumberId = value?.metadata?.phone_number_id;

      const contactName =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.profile?.formatted_name ||
        "";

      const telefono = from ? `+${from}` : "";

      // === 1) Leer estado actual del lead desde Lark (por wa_id) ===
      let lead = null;
      try {
        lead = await larkFindLatestLeadByWaId(from);
      } catch (e) {
        console.error("LARK_FIND_ERROR:", e?.message || e);
      }

      // Campo stage: en tu tabla actualmente se llama "Text 7"
      const STAGE_FIELD = "Text 7";

      // Si no existe el lead, lo creamos con stage=name
      if (!lead) {
        try {
          await larkCreateLead({
            wa_id: from || "",
            created_at_ms: Date.now(),
            nombre: contactName || "",
            telefono: telefono || "",
            stage: "name",
          });
        } catch (e) {
          const errMsg = String(e?.message || e);
          console.error("LARK_CREATE_ERROR:", errMsg);
          // Si no podemos guardar, igual respondemos algo útil
          return await sendWhatsAppAndAck({
            res,
            phoneNumberId,
            to: from,
            text: `Error guardando en CRM. Revisa logs. (${errMsg.slice(0, 80)})`,
          });
        }

        // Pregunta inicial
        return await sendWhatsAppAndAck({
          res,
          phoneNumberId,
          to: from,
          text: "Hola. Para registrarte, ¿cuál es tu *nombre*?",
        });
      }

      // Si existe lead, obtenemos stage actual
      const currentStage = (lead.fields?.[STAGE_FIELD] || "").toString().trim() || "name";

      // === 2) Procesar flujo por etapas ===
      // Etapas: name -> empresa -> ubicacion -> producto_interes -> intencion_cliente -> email -> done
      let nextReply = "OK";
      let updates = {};

      // Comando para reiniciar
      if (text.toLowerCase() === "reiniciar") {
        updates[STAGE_FIELD] = "name";
        nextReply = "Listo. Empecemos de nuevo. ¿Cuál es tu *nombre*?";
      } else if (currentStage === "name") {
        updates.nombre = text || (lead.fields?.nombre || "");
        updates[STAGE_FIELD] = "empresa";
        nextReply = "Gracias. ¿Cuál es el nombre de tu *empresa*?";
      } else if (currentStage === "empresa") {
        updates.empresa = text;
        updates[STAGE_FIELD] = "ubicacion";
        nextReply = "Perfecto. ¿En qué *ubicación* estás (ciudad/estado)?";
      } else if (currentStage === "ubicacion") {
        updates.ubicacion = text;
        updates[STAGE_FIELD] = "producto_interes";
        nextReply = "¿Qué *producto_interes* te interesa? (ej: Marcadoras láser)";
      } else if (currentStage === "producto_interes") {
        updates.producto_interes = text;
        updates[STAGE_FIELD] = "intencion_cliente";
        nextReply = "¿Cuál es tu *intencion_cliente*? (ej: Solicitar una DEMO / Cotización / Soporte)";
      } else if (currentStage === "intencion_cliente") {
        updates.intencion_cliente = text;
        updates[STAGE_FIELD] = "email";
        nextReply = "Por último, ¿cuál es tu *email*? (o escribe: omitir)";
      } else if (currentStage === "email") {
        if (text.toLowerCase() !== "omitir") updates.email = text;
        updates[STAGE_FIELD] = "done";
        nextReply = "Listo. Ya quedaste registrado. En breve un asesor se pondrá en contacto contigo.";
      } else {
        // done
        nextReply = "Ya estás registrado. Si quieres reiniciar, escribe: reiniciar";
      }

      // === 3) Guardar updates en Lark ===
      try {
        await larkUpdateLead(lead.record_id, updates);
      } catch (e) {
        console.error("LARK_UPDATE_ERROR:", e?.message || e, { updates });
        nextReply = `Registré tu mensaje, pero hubo un error actualizando el CRM.`;
      }

      // === 4) Responder por WhatsApp ===
      return await sendWhatsAppAndAck({
        res,
        phoneNumberId,
        to: from,
        text: nextReply,
      });

    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}

// =========================
// WhatsApp sender
// =========================
async function sendWhatsAppAndAck({ res, phoneNumberId, to, text }) {
  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  };

  const waToken = process.env.WHATSAPP_TOKEN;
  if (!waToken || !phoneNumberId || !to) {
    console.log("MISSING_WHATSAPP_DATA:", { hasToken: !!waToken, phoneNumberId, to });
    return send(200, "OK");
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text || "OK" },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const respData = await resp.json().catch(() => ({}));
  console.log("SEND_RESPONSE:", resp.status, JSON.stringify(respData, null, 2));
  return send(200, "OK");
}

// =========================
// LARK HELPERS
// =========================
async function larkGetTenantToken() {
  const now = Date.now();
  if (LARK_CACHE.token && LARK_CACHE.expiresAtMs > now + 60_000) return LARK_CACHE.token;

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET env vars");

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

function getBitableConfig() {
  const appToken = process.env.LARK_APP_TOKEN;
  const tableId = process.env.LARK_TABLE_ID;
  if (!appToken || !tableId) throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID env vars");
  // Sanitiza por si alguien mete querystring accidentalmente
  return { appToken: String(appToken).split("?")[0].trim(), tableId: String(tableId).trim() };
}

async function larkCreateLead({ wa_id, nombre, telefono, created_at_ms, stage }) {
  const tenantToken = await larkGetTenantToken();
  const { appToken, tableId } = getBitableConfig();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;

  // Tus campos reales (según capturas)
  const fields = {
    wa_id: String(wa_id || ""),
    created_at: Number(created_at_ms || Date.now()),
    nombre: String(nombre || ""),
    telefono: String(telefono || ""),
    "Text 7": String(stage || "name"), // stage
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark create record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  console.log("LARK_CREATED:", JSON.stringify(data, null, 2));
  return data;
}

async function larkFindLatestLeadByWaId(waId) {
  const tenantToken = await larkGetTenantToken();
  const appToken = String(process.env.LARK_APP_TOKEN || "").split("?")[0].trim();
  const tableId = String(process.env.LARK_TABLE_ID || "").trim();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`;

  const payload = {
    filter: {
      conjunction: "and",
      conditions: [{ field_name: "wa_id", operator: "is", value: [String(waId || "")] }],
    },
    page_size: 20,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark search error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  const items = data?.data?.items || [];
  if (items.length === 0) return null;

  // elegir el registro más reciente por created_at
  let best = items[0];
  let bestTs = Number(best?.fields?.created_at || 0);

  for (const it of items) {
    const ts = Number(it?.fields?.created_at || 0);
    if (ts > bestTs) {
      best = it;
      bestTs = ts;
    }
  }

  return { record_id: best.record_id, fields: best.fields || {} };
}


async function larkUpdateLead(recordId, updates) {
  if (!recordId) return;

  const tenantToken = await larkGetTenantToken();
  const { appToken, tableId } = getBitableConfig();

  // No mandar updates vacíos
  const fields = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (v !== undefined && v !== null) fields[k] = v;
  }
  if (Object.keys(fields).length === 0) return;

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark update record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  console.log("LARK_UPDATED:", recordId, JSON.stringify(fields, null, 2));
  return data;
}
