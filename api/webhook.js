// api/webhook.js

export default async function handler(req, res) {
  // Helper: responder sin Express (Vercel Serverless)
  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
    // Texto por defecto
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end(body);
  };

  // Helper: leer body (por si req.body no viene parseado)
  const readJsonBody = async (req) => {
    if (req.body && typeof req.body === "object") return req.body;
    if (req.body && typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    // Leer stream
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };

  // =========================
  // 1) Verificación (GET)
  // =========================
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];

    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
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

      // WhatsApp Cloud API: entry -> changes -> value -> messages[0]
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];

      // Responder rápido a Meta aunque no haya mensaje (statuses, etc.)
      // (Meta no requiere JSON aquí; con 200 OK basta)
      if (!msg) return send(200, "OK");

      const from = msg.from; // wa_id del usuario
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id;

      // 2.1) Pedir a Apps Script la respuesta (tu flujo + Google Sheets)
      const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // .../exec
      let flowReply = "";

      if (APPS_SCRIPT_URL) {
        try {
          const r = await fetch(APPS_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), // enviamos el payload completo
          });

          // Apps Script devuelve JSON: { reply: "..." }
          const data = await r.json().catch(() => null);
          flowReply = data?.reply || "";
          console.log("APPS_SCRIPT_REPLY:", JSON.stringify(data, null, 2));
        } catch (e) {
          console.error("APPS_SCRIPT_ERROR:", e);
        }
      }

      // Fallback si Apps Script no respondió
      const replyText = flowReply || `Recibido: ${text || "(sin texto)"}`;

      // 2.2) Enviar respuesta por Graph API
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

      // Listo
      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      return send(200, "OK"); // a Meta le contestamos 200 para no reintentar en bucle
    }
  }

  // Método no permitido
  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}

