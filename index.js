const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });


const express = require("express");

const app = express();
app.use(express.json());

// Healthcheck
app.get("/", (req, res) => res.status(200).send("OK"));

// Webhook verification (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const VERIFY_TOKEN = "jc_verify_123";
  if (!VERIFY_TOKEN) return res.sendStatus(500);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages/events
app.post("/webhook", async (req, res) => {
  // Importante: responder 200 rápido a Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

    // Validaciones básicas
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Ignorar si no es evento de mensajes
    const msg = value?.messages?.[0];
    if (!msg) return;

    // Ignorar estados (a veces llegan en otro tipo de payload)
    // (Si quieres, luego lo refinamos con más filtros)
    const from = msg.from; // wa_id del usuario (destino al responder)

    // Solo texto por ahora (luego agregamos botones/menú)
    const text = msg?.text?.body;
    if (!text) return;

    // Datos para responder
    const phoneNumberId = value?.metadata?.phone_number_id; // viene en el webhook
    const token = process.env.WHATSAPP_TOKEN; // lo configuraremos en el siguiente paso

    if (!phoneNumberId || !token) {
      console.log("Falta PHONE_NUMBER_ID o WHATSAPP_TOKEN (token env).");
      return;
    }

    // Respuesta simple (para probar)
    const replyText = `Recibido: ${text}`;

    // Enviar respuesta a WhatsApp Cloud API
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
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("WEBHOOK_ERROR:", err);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
