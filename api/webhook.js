// api/webhook.js
// WhatsApp Cloud API Webhook (Vercel)
// - GET: verificación (hub.challenge)
// - POST: recibe mensajes
//   (A) pide respuesta a Apps Script (para mantener tu flujo como antes)
//   (B) guarda SIEMPRE en Lark Bitable
//   (C) responde al usuario por Graph API

let LARK_CACHE = {
  token: null,
  expiresAtMs: 0,
};

export default async function handler(req, res) {
  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
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
  // 1) Verificación (GET)
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    // Nota: si entras por navegador a /api/webhook sin hub.*, ES NORMAL que dé 403.
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return send(200, String(challenge || ""));
    }
    return send(403, "Forbidden");
  }

  // =========================
  // 2) Eventos (POST)
  // =========================
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      // WhatsApp Cloud API: entry -> changes -> value
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Puede venir statuses, messages, etc.
      const msg = value?.messages?.[0];

      // Responder rápido a Meta para evitar reintentos
      if (!msg) return send(200, "OK");

      const from = msg?.from; // wa_id del usuario (sin + normalmente)
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id;

      const contactName =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.profile?.formatted_name ||
        "Sin nombre";

      const telefono = from ? `+${from}` : "";

      // (A) Respuesta por tu flujo (Apps Script) - como antes
      const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // opcional
      let flowReply = "";

      if (APPS_SCRIPT_URL) {
        try {
          const r = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), // mandamos el payload completo
          });

          const data = await r.json().catch(() => null);
          flowReply = data?.reply || "";
          console.log("APPS_SCRIPT_REPLY:", JSON.stringify(data, null, 2));
        } catch (e) {
          console.error("APPS_SCRIPT_ERROR:", e);
        }
      }

      // Fallback si Apps Script no respondió
      const replyText = flowReply || `Recibido: ${text || "(sin texto)"}`;

      // (B) Guardar en Lark (NO bloqueamos la respuesta si falla Lark)
      try {
        await larkCreateLead({
          wa_id: from || "",
          nombre: contactName || "",
          telefono: telefono || "",
          mensaje: text || "",
          created_at_ms: Date.now(),
        });
      } catch (e) {
        console.error("LARK_SAVE_ERROR:", e);
      }

      // (C) Responder al usuario por Graph API
      const waToken = process.env.WHATSAPP_TOKEN;

      if (!waToken || !phoneNumberId || !from) {
        console.log("MISSING_WHATSAPP_DATA:", {
          hasToken: !!waToken,
          phoneNumberId,
          from,
        });
        return send(200, "OK");
      }

      const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
      const payload = {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: replyText },
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${waToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const respData = await resp.json().catch(() => ({}));
      console.log("SEND_RESPONSE:", resp.status, JSON.stringify(respData, null, 2));

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}

// =========================
// LARK HELPERS
// =========================

async function larkGetTenantToken() {
  const now = Date.now();
  if (LARK_CACHE.token && LARK_CACHE.expiresAtMs > now + 60_000) {
    return LARK_CACHE.token;
  }

  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET env vars");
  }

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

  // expire viene en segundos normalmente
  const expireSec = Number(data?.expire || 0);
  LARK_CACHE.token = data.tenant_access_token;
  LARK_CACHE.expiresAtMs = Date.now() + (expireSec > 0 ? expireSec * 1000 : 60 * 60 * 1000);

  return LARK_CACHE.token;
}

async function larkCreateLead({ wa_id, nombre, telefono, mensaje, created_at_ms }) {
  const appToken = process.env.LARK_APP_TOKEN;  // ej: LLr7b0Q81a9FAWsyg8QlvFPQgVh
  const tableId = process.env.LARK_TABLE_ID;    // ej: tblRYrOLDCitUkta

  if (!appToken || !tableId) {
    throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID env vars");
  }

  const tenantToken = await larkGetTenantToken();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  // IMPORTANTE:
  // - created_at: si tu campo es Date/Datetime en Lark, manda MILISEGUNDOS.
  // - NUNCA metas "=" al inicio (eso provoca que Lark lo trate como fórmula).
  const fields = {
    wa_id: String(wa_id || ""),
    nombre: String(nombre || ""),
    telefono: String(telefono || ""),
    created_at: Number(created_at_ms || Date.now()),
  };

  // Solo si en tu tabla existe un campo llamado "mensaje"
  // (si no existe, bórralo para evitar 400)
  if (process.env.LARK_HAS_MENSAJE_FIELD === "1") {
    fields.mensaje = String(mensaje || "");
  }

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
