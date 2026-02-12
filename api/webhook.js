// api/webhook.js (Vercel - CommonJS)
// Flujo rápido en Node + Persistencia en Lark (MISMA TABLA, filtrado por campo "sucursal")

let LARK_CACHE = { token: null, expiresAtMs: 0 };

// dedupe simple en memoria (sirve por instancia)
const SEEN = new Map(); // msgId -> expiresAt
const SEEN_TTL_MS = 5 * 60 * 1000;

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

    if (mode === "subscribe") {
      if (token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
        return send(200, String(challenge || ""));
      }
      return send(403, "Forbidden");
    }
    return send(200, "ok");
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

      if (!msg) return send(200, "OK");

      // dedupe por message id
      const msgId = msg?.id;
      const now = Date.now();
      for (const [k, exp] of SEEN) if (exp <= now) SEEN.delete(k);
      if (msgId && SEEN.has(msgId)) {
        console.log("DEDUP_SKIP:", msgId);
        return send(200, "OK");
      }
      if (msgId) SEEN.set(msgId, now + SEEN_TTL_MS);

      const from = msg?.from;
      const text = (msg?.text?.body || "").trim();
      const phoneNumberId = value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

      const waToken = process.env.WHATSAPP_TOKEN;
      if (!waToken || !phoneNumberId || !from) {
        console.log("MISSING_WHATSAPP_DATA:", { hasToken: !!waToken, phoneNumberId, from });
        return send(200, "OK");
      }

      const replyText = await handleFlowAndPersist({
        wa_id: String(from),
        userText: text,
      });

      await sendWhatsAppText({
        waToken,
        phoneNumberId,
        to: from,
        body: replyText,
      });

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
// FLOW (Node) + Lark persistence (MISMA TABLA)
// =========================

const STAGES = {
  ASK_BRANCH: "ASK_BRANCH",
  ASK_PRODUCT: "ASK_PRODUCT",
  ASK_INTENT: "ASK_INTENT",
  ASK_NAME: "ASK_NAME",
  ASK_COMPANY: "ASK_COMPANY",
  ASK_LOCATION: "ASK_LOCATION",
  ASK_PHONE: "ASK_PHONE",
  ASK_EMAIL: "ASK_EMAIL",
  COMPLETED: "COMPLETED",
};

function stageFieldName() {
  return (process.env.LARK_STAGE_FIELD || "stage").trim();
}

function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isMenu(textNorm) {
  return textNorm === "menu" || textNorm === "reiniciar" || textNorm === "reset";
}

function parseBranch(text) {
  const t = normalizeText(text);
  if (t === "1" || t.includes("cdmx") || t.includes("mexico") || t.includes("ciudad")) return "CDMX";
  if (t === "2" || t.includes("mty") || t.includes("monterrey")) return "MTY";
  return null;
}

function parseProduct(text) {
  const t = normalizeText(text);
  if (t === "1" || t.includes("limpi")) return "Limpiadoras láser";
  if (t === "2" || t.includes("sold")) return "Soldadoras láser";
  if (t === "3" || t.includes("marca")) return "Marcadoras láser";
  if (t === "4" || t.includes("otro")) return "Otro";
  return null;
}

function parseIntent(text) {
  const t = normalizeText(text);
  if (t === "1" || t.includes("cot")) return "Cotización";
  if (t === "2" || t.includes("demo")) return "DEMO";
  if (t === "3" || t.includes("info")) return "Más información";
  return null;
}

function looksLikePhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  return digits.length >= 8;
}
function normalizePhone(text) {
  return String(text || "").replace(/\D/g, "");
}
function looksLikeEmail(text) {
  const t = String(text || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

async function handleFlowAndPersist({ wa_id, userText }) {
  const textNorm = normalizeText(userText);
  const sf = stageFieldName();

  // MENU / REINICIAR
  if (isMenu(textNorm)) {
    await larkCloseAnyOpenSession(wa_id).catch(() => {});
    // creamos nueva sesión arrancando en sucursal
    await larkCreateSession({ wa_id, stage: STAGES.ASK_BRANCH }).catch(() => {});
    return [
      "Listo. Reiniciamos tu solicitud.",
      "",
      "¿Con qué sucursal quieres continuar?",
      "",
      "1) CDMX",
      "2) Monterrey",
      "",
      "Responde 1 o 2 (o escribe CDMX / MTY).",
    ].join("\n");
  }

  // Buscar sesión abierta
  let session = await larkFindOpenSession(wa_id);

  // Si no hay sesión, crear y preguntar sucursal
  if (!session) {
    session = await larkCreateSession({ wa_id, stage: STAGES.ASK_BRANCH });
  }

  const { tableId, recordId, stage } = session;

  const setStage = async (newStage) => {
    await larkUpdateRecord(tableId, recordId, { [sf]: newStage });
  };

  const setFields = async (fields) => {
    await larkUpdateRecord(tableId, recordId, fields);
  };

  // ===== STAGES =====
  if (stage === STAGES.ASK_BRANCH) {
    const branch = parseBranch(userText);
    if (!branch) {
      return [
        "¿Con qué sucursal quieres continuar?",
        "",
        "1) CDMX",
        "2) Monterrey",
        "",
        "Responde 1 o 2 (o escribe CDMX / MTY).",
      ].join("\n");
    }

    // ✅ Guardamos sucursal como CAMPO (para que tus views filtren)
    await setFields({ sucursal: branch, [sf]: STAGES.ASK_PRODUCT });

    return [
      `Perfecto ✅ Sucursal: ${branch}`,
      "",
      "Hola, gracias por contactar a FEIYANG MAQUINARIA.",
      "Por favor selecciona una opción escribiendo el número:",
      "1) Limpiadoras láser",
      "2) Soldadoras láser",
      "3) Marcadoras láser",
      "4) Otro",
    ].join("\n");
  }

  if (stage === STAGES.ASK_PRODUCT) {
    const prod = parseProduct(userText);
    if (!prod) {
      return [
        "Por favor selecciona una opción escribiendo el número:",
        "1) Limpiadoras láser",
        "2) Soldadoras láser",
        "3) Marcadoras láser",
        "4) Otro",
      ].join("\n");
    }
    await setFields({ producto_interes: prod, [sf]: STAGES.ASK_INTENT });
    return [
      "Perfecto.",
      "¿Qué te gustaría hacer?",
      "1) Solicitar una cotización",
      "2) Solicitar una DEMO",
      "3) Recibir más información",
    ].join("\n");
  }

  if (stage === STAGES.ASK_INTENT) {
    const intent = parseIntent(userText);
    if (!intent) {
      return [
        "¿Qué te gustaría hacer?",
        "1) Solicitar una cotización",
        "2) Solicitar una DEMO",
        "3) Recibir más información",
      ].join("\n");
    }
    await setFields({ intencion_cliente: intent, [sf]: STAGES.ASK_NAME });
    return "Excelente elección.\nPara continuar, ¿podrías indicarnos tu nombre completo?";
  }

  if (stage === STAGES.ASK_NAME) {
    const name = String(userText || "").trim();
    if (name.length < 2) return "Para continuar, ¿podrías indicarnos tu nombre completo?";
    await setFields({ nombre: name, [sf]: STAGES.ASK_COMPANY });
    return "Gracias. ¿Cuál es el nombre de tu empresa o taller?";
  }

  if (stage === STAGES.ASK_COMPANY) {
    const company = String(userText || "").trim();
    if (company.length < 2) return "¿Cuál es el nombre de tu empresa o taller?";
    await setFields({ empresa: company, [sf]: STAGES.ASK_LOCATION });
    return "¿En qué ciudad y estado te encuentras?";
  }

  if (stage === STAGES.ASK_LOCATION) {
    const loc = String(userText || "").trim();
    if (loc.length < 2) return "¿En qué ciudad y estado te encuentras?";
    await setFields({ ubicacion: loc, [sf]: STAGES.ASK_PHONE });
    return "¿Cuál es tu número de teléfono para contactarte?";
  }

  if (stage === STAGES.ASK_PHONE) {
    if (!looksLikePhone(userText)) return "¿Cuál es tu número de teléfono para contactarte?";
    const phone = normalizePhone(userText);
    await setFields({ telefono: phone, [sf]: STAGES.ASK_EMAIL });
    return "Por último, ¿nos compartes tu correo electrónico?";
  }

  if (stage === STAGES.ASK_EMAIL) {
    if (!looksLikeEmail(userText)) return "Por último, ¿nos compartes tu correo electrónico? (Ej: nombre@correo.com)";
    const email = String(userText).trim();

    await setFields({ email, [sf]: STAGES.COMPLETED });

    const rec = await larkReadRecord(tableId, recordId).catch(() => null);
    const f = rec?.fields || {};

    return [
      "¡Gracias! Hemos registrado tus datos:",
      `Sucursal: ${f.sucursal || ""}`,
      `- Nombre: ${f.nombre || ""}`,
      `- Empresa: ${f.empresa || ""}`,
      `- Ubicación: ${f.ubicacion || ""}`,
      `- Teléfono: ${f.telefono || ""}`,
      `- Email: ${f.email || ""}`,
      "",
      "En breve un asesor se pondrá en contacto contigo.",
      "",
      "(Escribe 'menu' para reiniciar)",
    ].join("\n");
  }

  if (stage === STAGES.COMPLETED) {
    return "Ya tengo tu solicitud registrada ✅\nEscribe 'menu' para reiniciar.";
  }

  // fallback
  await setStage(STAGES.ASK_BRANCH).catch(() => {});
  return [
    "Listo. Reiniciamos tu solicitud.",
    "",
    "¿Con qué sucursal quieres continuar?",
    "",
    "1) CDMX",
    "2) Monterrey",
    "",
    "Responde 1 o 2 (o escribe CDMX / MTY).",
  ].join("\n");
}

// =========================
// WhatsApp sender
// =========================
async function sendWhatsAppText({ waToken, phoneNumberId, to, body }) {
  const waUrl = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: String(body || "") },
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
  if (!waResp.ok) {
    throw new Error(`WhatsApp send failed status=${waResp.status} body=${JSON.stringify(waRespData)}`);
  }
}

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

function cleanAppToken(appTokenRaw) {
  return String(appTokenRaw || "").split("?")[0].trim();
}
function getAppTokenOrThrow() {
  const appTokenRaw = process.env.LARK_APP_TOKEN;
  if (!appTokenRaw) throw new Error("Missing LARK_APP_TOKEN");
  return cleanAppToken(appTokenRaw);
}
function getTableIdOrThrow() {
  const tableId = process.env.LARK_TABLE_ID;
  if (!tableId) throw new Error("Missing LARK_TABLE_ID");
  return tableId;
}

async function larkCreateSession({ wa_id, stage }) {
  const appToken = getAppTokenOrThrow();
  const tableId = getTableIdOrThrow();
  const tenantToken = await larkGetTenantToken();
  const sf = stageFieldName();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const fields = {
    wa_id: String(wa_id || ""),
    created_at: Date.now(),
    [sf]: String(stage || STAGES.ASK_BRANCH),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0 || !data?.data?.record?.record_id) {
    throw new Error(`Lark create record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  return {
    tableId,
    recordId: data.data.record.record_id,
    stage: fields[sf],
  };
}

async function larkUpdateRecord(tableId, recordId, fields) {
  const appToken = getAppTokenOrThrow();
  const tenantToken = await larkGetTenantToken();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark update record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }
  return data;
}

async function larkReadRecord(tableId, recordId) {
  const appToken = getAppTokenOrThrow();
  const tenantToken = await larkGetTenantToken();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${tenantToken}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark read record error: status=${resp.status} body=${JSON.stringify(data)}`);
  }
  return data?.data?.record || null;
}

async function larkFindOpenSession(wa_id) {
  const appToken = getAppTokenOrThrow();
  const tableId = getTableIdOrThrow();
  const tenantToken = await larkGetTenantToken();
  const sf = stageFieldName();

  const filter = `CurrentValue.[wa_id] = "${String(wa_id).replace(/"/g, '\\"')}" AND CurrentValue.[${sf}] != "${STAGES.COMPLETED}"`;

  const url =
    `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records` +
    `?page_size=20&filter=${encodeURIComponent(filter)}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${tenantToken}` },
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.code !== 0) {
    throw new Error(`Lark list records error: status=${resp.status} body=${JSON.stringify(data)}`);
  }

  const items = data?.data?.items || [];
  if (!items.length) return null;

  items.sort((a, b) => Number(b?.fields?.created_at || 0) - Number(a?.fields?.created_at || 0));
  const rec = items[0];
  const stage = rec?.fields?.[sf] || STAGES.ASK_BRANCH;

  return {
    tableId,
    recordId: rec.record_id,
    stage: String(stage),
  };
}

async function larkCloseAnyOpenSession(wa_id) {
  const s = await larkFindOpenSession(wa_id);
  if (!s) return;
  const sf = stageFieldName();
  await larkUpdateRecord(s.tableId, s.recordId, { [sf]: "CLOSED_BY_MENU" });
}
