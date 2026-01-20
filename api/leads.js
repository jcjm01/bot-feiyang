// api/leads.js
let cachedToken = null;
let cachedTokenExp = 0; // epoch ms

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExp - 60_000) return cachedToken; // 1 min buffer

  const resp = await fetch("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });

  const data = await resp.json();
  if (!resp.ok || data.code !== 0) {
    throw new Error(`Lark token error: http=${resp.status} code=${data.code} msg=${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  const expiresInSec = data.expire || 3600;
  cachedTokenExp = now + expiresInSec * 1000;

  return cachedToken;
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null) out[k] = obj[k];
  return out;
}

// Lee el raw body cuando Vercel/Node no lo da parseado como esperas
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function safeJsonParse(maybeJson) {
  if (maybeJson === null || maybeJson === undefined) return {};
  if (typeof maybeJson === "object") return maybeJson; // ya viene parseado
  if (Buffer.isBuffer(maybeJson)) {
    const s = maybeJson.toString("utf8");
    return s ? JSON.parse(s) : {};
  }
  if (typeof maybeJson === "string") {
    const s = maybeJson.trim();
    if (!s) return {};
    return JSON.parse(s);
  }
  // fallback
  return {};
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    // Seguridad simple por API key
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.LEADS_API_KEY) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    // 1) Intento normal
    let body;
    try {
      body = safeJsonParse(req.body);
    } catch (e) {
      body = null;
    }

    // 2) Si falló, leo raw body y vuelvo a parsear
    if (!body) {
      const raw = await readRawBody(req);
      try {
        body = safeJsonParse(raw);
      } catch (e) {
        return json(res, 400, {
          ok: false,
          error: "Invalid JSON",
          hint: "Asegúrate que Postman esté en Body -> raw -> JSON y Content-Type=application/json",
          raw_preview: String(raw || "").slice(0, 200),
        });
      }
    }

    const allowedFields = [
      "wa_id",
      "producto_interes",
      "intencion_cliente",
      "nombre",
      "empresa",
      "ubicacion",
      "telefono",
      "email",
    ];

    const createdAt = body.created_at ? Number(body.created_at) : Date.now();

    const fields = {
      ...pick(body, allowedFields),
      created_at: createdAt,
    };

    if (!fields.wa_id) {
      return json(res, 400, { ok: false, error: "wa_id is required" });
    }

    const token = await getTenantToken();

    const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${process.env.LARK_APP_TOKEN}/tables/${process.env.LARK_TABLE_ID}/records`;

    const larkResp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ fields }),
    });

    const larkData = await larkResp.json();

    if (!larkResp.ok || larkData.code !== 0) {
      return json(res, 502, {
        ok: false,
        error: "Lark API error",
        lark_http: larkResp.status,
        lark_code: larkData.code,
        lark_msg: larkData.msg,
        lark_data: larkData.data,
      });
    }

    return json(res, 200, {
      ok: true,
      record_id: larkData?.data?.record?.record_id,
      created_at: fields.created_at,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "Server error" });
  }
}
