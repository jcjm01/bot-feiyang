// api/webhook.js

export default async function handler(req, res) {
  // Helper: responder rápido
  const send = (statusCode, body = "OK", contentType = "text/plain; charset=utf-8") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", contentType);
    res.end(body);
  };

  // Helper: leer body JSON (por si Vercel no lo parsea)
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
  // 1) Verificación (GET) Meta
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return send(200, String(challenge || ""), "text/plain; charset=utf-8");
    }
    return send(403, "Forbidden");
  }

  // =========================
  // Helpers Lark
  // =========================
  const getLarkTenantToken = async () => {
    const LARK_APP_ID = process.env.LARK_APP_ID;
    const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
    if (!LARK_APP_ID || !LARK_APP_SECRET) return null;

    const r = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
    });

    const data = await r.json().catch(() => null);
    if (!data || data.code !== 0) {
      console.log("LARK_TOKEN_ERROR:", r.status, JSON.stringify(data || {}, null, 2));
      return null;
    }
    return data.tenant_access_token;
  };

  const createLarkRecord = async ({ wa_id, nombre, telefono, created_at }) => {
    const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN;   // Bitable app token (LLr7...)
    const LARK_TABLE_ID = process.env.LARK_TABLE_ID;     // tbl...
    if (!LARK_APP_TOKEN || !LARK_TABLE_ID) {
      console.log("LARK_MISSING_TABLE_CONFIG:", { hasAppToken: !!LARK_APP_TOKEN, hasTableId: !!LARK_TABLE_ID });
      return null;
    }

    const tenantToken = await getLarkTenantToken();
    if (!tenantToken) return null;

    const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${LARK_APP_TOKEN}/tables/${LARK_TABLE_ID}/records`;

    const payload = {
      fields: {
        wa_id: wa_id || "",
        nombre: nombre || "",
        telefono: telefono || "",
        created_at: typeof created_at === "number" ? created_at : Date.now(),
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => null);
    if (!data || data.code !== 0) {
      console.log("LARK_CREATE_ERROR:", r.status, JSON.stringify(data || {}, null, 2));
      return null;
    }
    return data;
  };

  // =========================
  // 2) Eventos (POST) WhatsApp
  // =========================
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];

      // Puede llegar "statuses" sin "messages"
      if (!msg) return send(200, "OK");

      const from = msg?.from; // wa_id usuario
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id;

      // nombre a veces viene aquí (depende del evento)
      const nombre =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.wa_id ||
        "";

      const telefono = from || "";

      // 2.1) Llamar Apps Script para obtener reply (flujo)
      const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
      let flowReply = "";

      if (APPS_SCRIPT_URL) {
        try {
          // Enviamos un payload compacto + el raw por si tu script lo necesita
          const appsPayload = {
            wa_id: from,
            text,
            phone_number_id: phoneNumberId,
            raw: body,
          };

          const r = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(appsPayload),
          });

          // IMPORTANTE: Apps Script a veces responde text/plain
          const rawText = await r.text();
          let parsed = null;
          try { parsed = JSON.parse(rawText); } catch { parsed = null; }

          flowReply =
            parsed?.reply ||
            parsed?.text ||
            (typeof parsed === "string" ? parsed : "") ||
            (rawText && rawText.trim().startsWith("{") ? "" : rawText.trim());

          console.log("APPS_SCRIPT_HTTP:", r.status);
          console.log("APPS_SCRIPT_RAW:", rawText);
          console.log("APPS_SCRIPT_REPLY_FINAL:", flowReply);
        } catch (e) {
          console.error("APPS_SCRIPT_ERROR:", e);
        }
      } else {
        console.log("APPS_SCRIPT_URL_NOT_SET");
      }

      // 2.2) Guardar lead en Lark (no bloquea la respuesta)
      // Si Lark falla, no rompemos el webhook
      try {
        await createLarkRecord({
          wa_id: from,
          nombre: nombre || "",
          telefono: telefono || "",
          created_at: Date.now(),
        });
      } catch (e) {
        console.error("LARK_SAVE_ERROR:", e);
      }

      // 2.3) Responder por WhatsApp
      const replyText = flowReply || `Recibido: ${text || "(sin texto)"}`;

      const token = process.env.WHATSAPP_TOKEN;
      if (!token || !phoneNumberId || !from) {
        console.log("MISSING_DATA:", { hasToken: !!token, phoneNumberId, from });
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
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      // Respondemos 200 para que Meta no reintente en bucle
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}
