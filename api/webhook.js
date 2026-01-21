// api/webhook.js
// WhatsApp Cloud API Webhook (Vercel)
// Flujo ORIGINAL + guardado directo en Lark Bitable

let LARK_CACHE = { token: null, expiresAtMs: 0 };

const PRODUCT_MENU =
  "Hola, gracias por contactar a FEIYANG MAQUINARIA.\n" +
  "Por favor selecciona una opción escribiendo el número:\n" +
  "1) Limpiadoras láser\n" +
  "2) Soldadoras láser\n" +
  "3) Marcadoras láser\n" +
  "4) Otro";

const INTENT_MENU =
  "Perfecto.\n" +
  "¿Qué te gustaría hacer?\n" +
  "1) Solicitar una cotización\n" +
  "2) Solicitar una DEMO\n" +
  "3) Recibir más información";

const PRODUCT_MAP = {
  "1": "Limpiadoras láser",
  "2": "Soldadoras láser",
  "3": "Marcadoras láser",
  "4": "Otro",
};

const INTENT_MAP = {
  "1": "Solicitar una cotización",
  "2": "Solicitar una DEMO",
  "3": "Recibir más información",
};

function norm(s) {
  return String(s || "").trim();
}

function isEmail(s) {
  const t = norm(s);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

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

  // =========================
  // GET verify
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return send(200, String(challenge || ""));
    }
    return send(403, "Forbidden");
  }

  // =========================
  // POST events
  // =========================
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];
      if (!msg) return send(200, "OK");

      const from = msg?.from; // wa_id
      const text = norm(msg?.text?.body || "");
      const phoneNumberId = value?.metadata?.phone_number_id;

      const contactName =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.profile?.formatted_name ||
        "";

      // Campo stage (recomendado: Text 7). Si lo renombraste, pon env LARK_STAGE_FIELD
      const STAGE_FIELD = process.env.LARK_STAGE_FIELD || "Text 7";

      // Buscar lead más reciente por wa_id (evita bug por duplicados)
      let lead = await larkFindLatestLeadByWaId(from).catch((e) => {
        console.error("LARK_FIND_ERROR:", e?.message || e);
        return null;
      });

      // === Reiniciar: crear nuevo registro y volver a menú producto
      if (text.toLowerCase() === "reiniciar") {
        await larkCreateLead({
          wa_id: from || "",
          created_at_ms: Date.now(),
          nombre: contactName || "",
          telefono: "", // se captura luego (como tu flujo)
          mensaje: "reiniciar",
          stageFieldName: STAGE_FIELD,
          stage: "product_menu",
        }).catch((e) => console.error("LARK_CREATE_ERROR:", e?.message || e));

        return await sendWhatsAppAndAck({
          res, phoneNumberId, to: from,
          text: "Listo. Reiniciamos tu solicitud.\n\n" + PRODUCT_MENU,
        });
      }

      // Si no existe lead: crear y mandar menú inicial
      if (!lead) {
        await larkCreateLead({
          wa_id: from || "",
          created_at_ms: Date.now(),
          nombre: contactName || "",
          telefono: "",
          mensaje: text,
          stageFieldName: STAGE_FIELD,
          stage: "product_menu",
        }).catch((e) => console.error("LARK_CREATE_ERROR:", e?.message || e));

        return await sendWhatsAppAndAck({
          res, phoneNumberId, to: from,
          text: PRODUCT_MENU,
        });
      }

      // Stage actual
      const stage = norm(lead.fields?.[STAGE_FIELD] || "") || "product_menu";

      // Siempre guardamos el mensaje actual en columna `mensaje` (raw_message)
      // (esto requiere que tu tabla tenga campo `mensaje`, según tus capturas sí existe)
      let updates = { mensaje: text };
      let reply = "OK";

      // =========================
      // FLUJO ORIGINAL
      // =========================
      if (stage === "product_menu") {
        if (!PRODUCT_MAP[text]) {
          reply = "Opción no válida. Por favor responde con 1, 2, 3 o 4.";
        } else {
          updates.producto_interes = PRODUCT_MAP[text];
          updates[STAGE_FIELD] = "intent_menu";
          reply = INTENT_MENU;
        }
      } else if (stage === "intent_menu") {
        if (!INTENT_MAP[text]) {
          reply = "Opción no válida. Por favor responde con 1, 2 o 3.";
        } else {
          updates.intencion_cliente = INTENT_MAP[text];
          updates[STAGE_FIELD] = "ask_name";
          reply = "Excelente elección.\nPara continuar, ¿podrías indicarnos tu nombre completo?";
        }
      } else if (stage === "ask_name") {
        updates.nombre = text || (lead.fields?.nombre || contactName || "");
        updates[STAGE_FIELD] = "ask_company";
        reply = "Gracias. ¿Cuál es el nombre de tu empresa o taller?";
      } else if (stage === "ask_company") {
        updates.empresa = text;
        updates[STAGE_FIELD] = "ask_location";
        reply = "¿En qué ciudad y estado te encuentras?";
      } else if (stage === "ask_location") {
        updates.ubicacion = text;
        updates[STAGE_FIELD] = "ask_phone";
        reply = "¿Cuál es tu número de teléfono para contactarte?";
      } else if (stage === "ask_phone") {
        updates.telefono = text;
        updates[STAGE_FIELD] = "ask_email";
        reply = "Por último, ¿nos compartes tu correo electrónico?";
      } else if (stage === "ask_email") {
        // Si no es email válido, se lo volvemos a pedir (como seguridad mínima)
        if (!isEmail(text)) {
          reply = "Correo no válido. Por favor escribe un correo electrónico válido (ej: nombre@dominio.com)";
        } else {
          updates.email = text;
          updates[STAGE_FIELD] = "done";

          // Armar resumen como tu bot original
          const nombre = updates.nombre || lead.fields?.nombre || "";
          const empresa = updates.empresa || lead.fields?.empresa || "";
          const ubicacion = updates.ubicacion || lead.fields?.ubicacion || "";
          const telefono = updates.telefono || lead.fields?.telefono || "";
          const email = updates.email || lead.fields?.email || "";

          reply =
            "¡Gracias! Hemos registrado tus datos:\n" +
            `• Nombre: ${nombre}\n` +
            `• Empresa: ${empresa}\n` +
            `• Ubicación: ${ubicacion}\n` +
            `• Teléfono: ${telefono}\n` +
            `• Email: ${email}\n\n` +
            "En breve un asesor se pondrá en contacto contigo.";
        }
      } else if (stage === "done") {
        reply = "Ya estás registrado. Si quieres reiniciar, escribe: reiniciar";
      } else {
        // Stage desconocido: reiniciar soft al menú
        updates[STAGE_FIELD] = "product_menu";
        reply = PRODUCT_MENU;
      }

      // Guardar updates en el registro más reciente
      try {
        await larkUpdateLead(lead.record_id, updates);
      } catch (e) {
        console.error("LARK_UPDATE_ERROR:", e?.message || e, { record_id: lead.record_id, updates });
        // Aun si falla update, respondemos para que WhatsApp no reintente
      }

      // Responder por WhatsApp
      return await sendWhatsAppAndAck({ res, phoneNumberId, to: from, text: reply });

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
  const waToken = process.env.WHATSAPP_TOKEN;

  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  };

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
// Lark helpers
// =========================
async function larkGetTenantToken() {
  const now = Date.now();
  if (LARK_CACHE.token && LARK_CACHE.expiresAtMs > now + 60_000) return LARK_CACHE.token;

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

function getBitableConfig() {
  const appTokenRaw = process.env.LARK_APP_TOKEN;
  const tableId = process.env.LARK_TABLE_ID;
  if (!appTokenRaw || !tableId) throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID");
  const appToken = String(appTokenRaw).split("?")[0].trim(); // por si alguien mete ?table=...
  return { appToken, tableId: String(tableId).trim() };
}

async function larkCreateLead({ wa_id, nombre, telefono, mensaje, created_at_ms, stageFieldName, stage }) {
  const tenantToken = await larkGetTenantToken();
  const { appToken, tableId } = getBitableConfig();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;

  // Campos EXACTOS según tus capturas
  const fields = {
    wa_id: String(wa_id || ""),
    created_at: Number(created_at_ms || Date.now()),
    nombre: String(nombre || ""),
    telefono: String(telefono || ""),
    mensaje: String(mensaje || ""),
  };

  // stage
  fields[String(stageFieldName || "Text 7")] = String(stage || "product_menu");

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
  const { appToken, tableId } = getBitableConfig();

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
    headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark search error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  const items = data?.data?.items || [];
  if (items.length === 0) return null;

  // Elegir el más reciente por created_at (ms)
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

  const fields = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (v !== undefined && v !== null) fields[k] = v;
  }
  if (Object.keys(fields).length === 0) return;

  const url =
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}` +
    `/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;

  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tenantToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  console.log("LARK_UPDATE_HTTP:", resp.status, JSON.stringify(data, null, 2));

  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark update record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  return data;
}
