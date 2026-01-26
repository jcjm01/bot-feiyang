// api/webhook.js (Vercel - CommonJS)
// WhatsApp -> (A) Apps Script (Sheets flow) -> reply
//          -> (B) Sync to Lark when FLOW_COMPLETED (heurística)
//          -> (C) Reply to WhatsApp

let LARK_CACHE = { token: null, expiresAtMs: 0 };

module.exports = async function handler(req, res) {
  const send = (code, body = "OK") => {
    res.statusCode = code;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  };

  const readJsonBody = async () => {
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

  // ========= GET verify =========
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

  // ========= POST events =========
  if (req.method === "POST") {
    try {
      const body = await readJsonBody();
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const msg = value?.messages?.[0];

      // A veces llegan "statuses" sin mensajes
      if (!msg) return send(200, "OK");

      const from = msg?.from;
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id;

      // ========= (A) Apps Script flow =========
      const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
      const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET;

      let replyText = "";

      if (!APPS_SCRIPT_URL) {
        console.log("MISSING_APPS_SCRIPT_URL");
        replyText = `Recibido: ${text || "(sin texto)"}`;
      } else if (!BOT_SHARED_SECRET) {
        console.log("MISSING_BOT_SHARED_SECRET");
        replyText = `Recibido: ${text || "(sin texto)"}`;
      } else {
        try {
          const url =
            APPS_SCRIPT_URL +
            (APPS_SCRIPT_URL.includes("?") ? "&" : "?") +
            "k=" +
            encodeURIComponent(BOT_SHARED_SECRET);

          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          const raw = await resp.text();
          console.log("APPS_SCRIPT_STATUS:", resp.status);
          console.log("APPS_SCRIPT_RAW:", raw);

          let data = null;
          try { data = JSON.parse(raw); } catch {}

          replyText = data?.reply || `Recibido: ${text || "(sin texto)"}`;
        } catch (e) {
          console.error("APPS_SCRIPT_ERROR:", e?.message || e);
          replyText = `Recibido: ${text || "(sin texto)"}`;
        }
      }

      // ========= (B) Sync to Lark (cuando el flujo terminó) =========
      const looksCompleted =
        typeof replyText === "string" &&
        replyText.includes("Hemos registrado tus datos");

      if (looksCompleted) {
        try {
          const contactName =
            value?.contacts?.[0]?.profile?.name ||
            value?.contacts?.[0]?.profile?.formatted_name ||
            "";

          await larkCreateLead({
            wa_id: String(from || ""),
            nombre: String(contactName || ""),
            telefono: from ? `+${from}` : "",
            mensaje: String(text || ""),
            created_at_ms: Date.now(),
          });

          console.log("LARK_SYNC_OK");
        } catch (e) {
          console.error("LARK_SYNC_ERROR:", e?.message || e);
        }
      } else {
        console.log("LARK_SYNC_SKIP:not_completed");
      }

      // ========= (C) Reply to WhatsApp =========
      const waToken = process.env.WHATSAPP_TOKEN;
      if (!waToken || !phoneNumberId || !from) {
        console.log("MISSING_WHATSAPP_DATA:", {
          hasToken: !!waToken,
          phoneNumberId,
          from,
        });
        return send(200, "OK");
      }

      const waUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
      const payload = {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: replyText },
      };

      const waResp = await fetch(waUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${waToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const waRespData = await waResp.json().catch(() => ({}));
      console.log("SEND_RESPONSE:", waResp.status, JSON.stringify(waRespData, null, 2));

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err?.message || err);
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
};

// =========================
// LARK HELPERS
// =========================

async function larkGetTenantToken() {
  const now = Date.now();
  if (LARK_CACHE.token && LARK_CACHE.expiresAtMs > now + 60000) return LARK_CACHE.token;

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

async function larkCreateLead({ wa_id, nombre, telefono, mensaje, created_at_ms }) {
  const appTokenRaw = process.env.LARK_APP_TOKEN;
  const tableId = process.env.LARK_TABLE_ID;

  if (!appTokenRaw || !tableId) throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID");

  const appToken = String(appTokenRaw).split("?")[0].trim();

  const tenantToken = await larkGetTenantToken();
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const fields = {
    wa_id: String(wa_id || ""),
    created_at: Number(created_at_ms || Date.now()),
  };

  if (process.env.LARK_FIELD_NOMBRE !== "0") fields.nombre = String(nombre || "");
  if (process.env.LARK_FIELD_TELEFONO !== "0") fields.telefono = String(telefono || "");
  if (process.env.LARK_FIELD_MENSAJE !== "0") fields.mensaje = String(mensaje || "");

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
