// api/webhook.js

export default async function handler(req, res) {
  // Helper: responder sin Express (Vercel Serverless)
  const send = (statusCode, body = "") => {
    res.statusCode = statusCode;
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
  // Helpers Lark
  // =========================
  const getLarkTenantToken = async ({ appId, appSecret }) => {
    const url =
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.code !== 0 || !data?.tenant_access_token) {
      throw new Error(
        `Lark tenant token error: HTTP ${r.status} ${JSON.stringify(data)}`
      );
    }
    return data.tenant_access_token;
  };

  const createLarkRecord = async ({
    tenantToken,
    appToken,
    tableId,
    fields,
  }) => {
    const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({ fields }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.code !== 0) {
      throw new Error(
        `Lark create record error: HTTP ${r.status} ${JSON.stringify(data)}`
      );
    }
    return data;
  };

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
      if (!msg) return send(200, "OK");

      const from = msg?.from; // wa_id del usuario (ej "521...")
      const phoneNumberId = value?.metadata?.phone_number_id;
      const text = msg?.text?.body || "";

      // Nombre si viene en contacts (a veces viene, a veces no)
      const contactName = value?.contacts?.[0]?.profile?.name || "";

      // =========================
      // 2.0) Guardar lead en Lark (Bitable)
      // =========================
      const SAVE_TO_LARK = process.env.SAVE_TO_LARK !== "0"; // default true

      const LARK_APP_ID = process.env.LARK_APP_ID;
      const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
      const LARK_APP_TOKEN = process.env.LARK_APP_TOKEN; // ej: LLr7...
      const LARK_TABLE_ID = process.env.LARK_TABLE_ID; // ej: tbl...

      // Solo para evitar registros raros
      const safeFrom = typeof from === "string" ? from.trim() : "";
      const safePhone = safeFrom ? `+${safeFrom}` : "";

      // Campos: usa los títulos EXACTOS de tus columnas en Lark
      const leadFields = {
        wa_id: safeFrom,
        nombre: contactName || "Sin nombre",
        telefono: safePhone,
        created_at: Date.now(), // timestamp (ms)
        // Si luego quieres guardar el texto:
        // ultimo_mensaje: text,
      };

      if (SAVE_TO_LARK) {
        if (!LARK_APP_ID || !LARK_APP_SECRET || !LARK_APP_TOKEN || !LARK_TABLE_ID) {
          console.log("LARK_ENV_MISSING:", {
            hasId: !!LARK_APP_ID,
            hasSecret: !!LARK_APP_SECRET,
            hasAppToken: !!LARK_APP_TOKEN,
            hasTableId: !!LARK_TABLE_ID,
          });
        } else if (safeFrom) {
          try {
            const tenantToken = await getLarkTenantToken({
              appId: LARK_APP_ID,
              appSecret: LARK_APP_SECRET,
            });

            const created = await createLarkRecord({
              tenantToken,
              appToken: LARK_APP_TOKEN,
              tableId: LARK_TABLE_ID,
              fields: leadFields,
            });

            console.log("LARK_RECORD_OK:", JSON.stringify(created, null, 2));
          } catch (e) {
            console.error("LARK_RECORD_ERROR:", e?.message || e);
          }
        } else {
          console.log("LARK_SKIP: missing from (wa_id)");
        }
      }

      // =========================
      // 2.1) Responder por WhatsApp (opcional)
      // =========================
      const token = process.env.WHATSAPP_TOKEN;
      if (!token || !phoneNumberId || !safeFrom) {
        console.log("MISSING_DATA_FOR_REPLY:", {
          hasToken: !!token,
          phoneNumberId,
          safeFrom,
        });
        return send(200, "OK");
      }

      const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

      const replyText = `Recibido: ${text || "(sin texto)"}`;

      const payload = {
        messaging_product: "whatsapp",
        to: safeFrom,
        type: "text",
        text: { body: replyText },
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      console.log("SEND_RESPONSE:", resp.status, JSON.stringify(data, null, 2));

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      // a Meta le contestamos 200 para no reintentar en bucle
      return send(200, "OK");
    }
  }

  // Método no permitido
  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}
