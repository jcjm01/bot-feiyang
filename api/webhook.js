// api/webhook.js

export default async function handler(req, res) {
  // ====== 1) Verificación (GET) para Meta ======
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // ====== 2) Eventos (POST) de WhatsApp ======
  if (req.method === "POST") {
    // Responder 200 rápido a Meta
    res.sendStatus(200);

    try {
      const body = req.body;
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      // Extraer mensaje
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];
      if (!msg) return; // no es mensaje (puede ser status)

      const from = msg.from;
      const text = msg?.text?.body || "";

      const phoneNumberId = value?.metadata?.phone_number_id;
      const waToken = process.env.WHATSAPP_TOKEN;

      if (!phoneNumberId || !waToken) {
        console.log("Falta phone_number_id o WHATSAPP_TOKEN.");
        return;
      }

      // ====== 3) Preguntar a Apps Script qué responder ======
      const appsUrl = process.env.APPS_SCRIPT_URL;
      if (!appsUrl) {
        console.log("Falta APPS_SCRIPT_URL en env vars.");
        return;
      }

      const appsResp = await fetch(appsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const appsData = await appsResp.json().catch(() => ({}));
      const replyText = appsData?.reply || "Gracias. Un asesor te contactará pronto.";

      console.log("APPS_REPLY:", replyText);

      // ====== 4) Enviar respuesta por WhatsApp Cloud API ======
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

      const data = await resp.json();
      console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
    }

    return;
  }

  return res.status(405).send("Method Not Allowed");
}
