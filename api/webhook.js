// api/webhook.js
// WhatsApp Cloud API Webhook (Vercel)
// - GET: verificación (hub.challenge)
// - POST: recibe mensajes, guarda en Lark Bitable y responde por Graph API

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

      const from = msg?.from; // wa_id del usuario
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id;

      const contactName =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.profile?.formatted_name ||
        "Sin nombre";

      const telefono = from ? `+${from}` : "";

      // Reply base (no dependemos de Apps Script)
      let replyText = "OK";

      // (A) Guardar en Lark (si falla, mostramos error breve en WhatsApp y en logs)
      try {
        await larkCreateLead({
          wa_id: from || "",
          nombre: contactName || "",
          telefono: telefono || "",
          mensaje: text || "",
          created_at_ms: Date.now(),
        });
      } catch (e) {
        const msgErr = String(e?.message || e);
        console.error("LARK_SAVE_ERROR_MESSAGE:", msgErr);
        // Debug visible (temporal): para que sepas exacto por qué falla
        replyText = `ERROR LARK: ${msgErr.slice(0, 140)}`;
      }

      // (B) Responder al usuario por Graph API
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
  // OJO: estas env deben existir en Vercel como en tu screenshot
  const appToken = process.env.LARK_APP_TOKEN;  // app_token de Bitable (no app_id)
  const tableId = process.env.LARK_TABLE_ID;

  if (!appToken || !tableId) {
    throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID env vars");
  }

  const tenantToken = await larkGetTenantToken();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${encodeURIComponent(
    appToken
  )}/tables/${encodeURIComponent(tableId)}/records`;

  // IMPORTANTE: los nombres de campos deben coincidir EXACTO con tu tabla
  const fields = {
    wa_id: String(wa_id || ""),
    nombre: String(nombre || ""),
    telefono: String(telefono || ""),
    mensaje: String(mensaje || ""), // SIEMPRE lo mandamos (para detectar si el campo existe)
    created_at: Number(created_at_ms || Date.now()), // Date en ms
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
