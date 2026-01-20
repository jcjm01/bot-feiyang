// api/webhook.js

export default async function handler(req, res) {
  const send = (statusCode, body = "OK") => {
    res.statusCode = statusCode;
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end(body);
  };

  const readJsonBody = async (req) => {
    if (req.body && typeof req.body === "object") return req.body;
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

  // ============ GET Verify (Meta) ============
  if (req.method === "GET") {
    const mode = req.query?.["hub.mode"];
    const token = req.query?.["hub.verify_token"];
    const challenge = req.query?.["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return send(200, String(challenge || ""));
    }
    return send(403, "Forbidden");
  }

  // ============ Helpers Lark ============
  const getTenantToken = async () => {
    const app_id = process.env.LARK_APP_ID;
    const app_secret = process.env.LARK_APP_SECRET;
    if (!app_id || !app_secret) {
      console.log("LARK missing app_id/app_secret");
      return null;
    }

    const r = await fetch(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id, app_secret }),
      }
    );

    const data = await r.json().catch(() => null);
    if (!data || data.code !== 0) {
      console.log("LARK tenant token error:", r.status, data);
      return null;
    }
    return data.tenant_access_token;
  };

  const createRecord = async (fields) => {
    const appToken = process.env.LARK_APP_TOKEN; // LLr7...
    const tableId = process.env.LARK_TABLE_ID;   // tbl...
    if (!appToken || !tableId) {
      console.log("LARK missing appToken/tableId");
      return null;
    }

    const tenantToken = await getTenantToken();
    if (!tenantToken) return null;

    const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tenantToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ fields }),
    });

    const data = await r.json().catch(() => null);
    if (!data || data.code !== 0) {
      console.log("LARK create record error:", r.status, data);
      return null;
    }

    console.log("LARK create record success:", data?.data?.record?.record_id);
    return data;
  };

  // ============ POST Webhook ============
  if (req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      const msg = value?.messages?.[0];

      // statuses, delivery receipts, etc.
      if (!msg) return send(200, "OK");

      const wa_id = msg?.from || "";
      const text = msg?.text?.body || "";

      // nombre (si viene)
      const nombre =
        value?.contacts?.[0]?.profile?.name ||
        value?.contacts?.[0]?.wa_id ||
        "";

      // Guardar lo que escribió el usuario
      // created_at debe ser número (ms) para tu campo Date en Lark
      const saved = await createRecord({
        wa_id,
        nombre,
        telefono: wa_id,
        mensaje: text,          // <-- IMPORTANTE: necesitas esta columna en Lark
        created_at: Date.now(),
      });

      // Si falla, deja evidencia
      if (!saved) {
        console.log("LARK_SAVE_FAILED");
      }

      return send(200, "OK");
    } catch (err) {
      console.error("WEBHOOK_ERROR:", err);
      return send(200, "OK");
    }
  }

  res.setHeader("Allow", "GET, POST");
  return send(405, "Method Not Allowed");
}
