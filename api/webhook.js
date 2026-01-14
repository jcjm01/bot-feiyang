export default async function handler(req, res) {
  // Verificación (GET)
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

  // Eventos (POST)
  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      // Responde rápido a Meta
      res.status(200).send("OK");

      // Procesar mensajes
      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const text = msg?.text?.body;
      if (!text) return;

      const phoneNumberId = value?.metadata?.phone_number_id;
      const token = process.env.WHATSAPP_TOKEN;
      if (!phoneNumberId || !token) return;

      const replyText = `Recibido: ${text}`;
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

      const data = await resp.json();
      console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));
      return;
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      return;
    }
  }

  return res.status(405).send("Method Not Allowed");
}
