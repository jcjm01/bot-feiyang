const BUILD_ID = "leads-2026-01-20-01";

// api/leads.js
let cachedToken = null;
let cachedTokenExp = 0; // epoch ms

async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExp - 60_000) return cachedToken; // 1 min buffer

  const resp = await fetch(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: process.env.LARK_APP_ID,
        app_secret: process.env.LARK_APP_SECRET,
      }),
    }
  );

  const data = await resp.json();
  if (!resp.ok || data.code !== 0) {
    throw new Error(
      `Lark token error: http=${resp.status} code=${data.code} msg=${data.msg}`
    );
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
  res.end(JSON.stringify(obj));
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null) out[k] = obj[k];
  return out;
}

/**
 * Body parser robusto:
 * - Soporta object (Next/Vercel ya parseado)
 * - Soporta string
 * - Soporta Buffer
 * - Si el string trae basura antes del '{' o '[', recorta desde el primer '{'/'['
 * - Si falla, devuelve 400 con una pista (raw_start) para que veamos qué está llegando
 */
function parseBody(req, res) {
  let raw = req.body;

  // Next.js suele dar object ya parseado
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) {
    return raw;
  }

  // Buffer -> string
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");

  // Nada
  if (raw === undefined || raw === null) return {};

  // Otros tipos -> string
  if (typeof raw !== "string") raw = String(raw);

  // Limpieza básica + BOM
  let trimmed = raw.trim().replace(/^\uFEFF/, "");

  // Recorta basura antes del JSON real
  const idx = trimmed.search(/[\{\[]/);
  const candidate = idx >= 0 ? trimmed.slice(idx) : trimmed;

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // OJO: esto es para debug. No exponemos todo, solo el inicio.
    return json(res, 400, {
      ok: false,
      error: "Invalid JSON (server could not parse body)",
      detail: e.message,
      raw_start: trimmed.slice(0, 120),
      raw_len: trimmed.length,
    });
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "Method Not Allowed" });
    }

    // Seguridad simple por API key
    const headerVal = req.headers["x-api-key"];
    const apiKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;

    if (!apiKey || apiKey !== process.env.LEADS_API_KEY) {
      return json(res, 401, { ok: false, error: "Unauthorized" });
    }

    // Parse robusto
    const body = parseBody(req, res);
    // Si parseBody ya respondió con 400, aquí body es undefined (porque json() terminó la response)
    if (!body || typeof body !== "object") return;

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
