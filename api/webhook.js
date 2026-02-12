// api/webhook.js (Vercel - CommonJS)
// OBJETIVO:
// - Responder rápido (Node decide la respuesta; no Apps Script)
// - Mantener cuestionario tipo Feiyang: Producto -> Interés -> Nombre -> Empresa -> Ciudad/Sucursal
// - Guardar en Lark al terminar

let LARK_CACHE = { token: null, expiresAtMs: 0 };

// Dedupe simple en memoria (sirve por instancia)
const SEEN = new Map(); // msgId -> expiresAt
const SEEN_TTL_MS = 5 * 60 * 1000;

// Estado simple en memoria (por instancia). Para producción se pasa a Lark/DB.
const STATE = new Map(); // wa_id -> { step, data, exp }
const STATE_TTL_MS = 60 * 60 * 1000; // 1 hora

function nowMs() { return Date.now(); }

function getState(wa_id) {
  const now = nowMs();
  const s = STATE.get(wa_id);
  if (!s || (s.exp && s.exp < now)) {
    const fresh = { step: "START", data: {}, exp: now + STATE_TTL_MS };
    STATE.set(wa_id, fresh);
    return fresh;
  }
  return s;
}

function setState(wa_id, next) {
  next.exp = nowMs() + STATE_TTL_MS;
  STATE.set(wa_id, next);
}

function resetState(wa_id) {
  STATE.delete(wa_id);
}

function norm(t) {
  return String(t || "").trim();
}

function normLow(t) {
  return norm(t).toLowerCase();
}

function isResetCommand(text) {
  const s = normLow(text);
  return s === "menu" || s === "hola" || s === "reiniciar" || s === "reset";
}

// ------- Cuestionario “Feiyang” -------
function askProducto() {
  return [
    "¡Hola! ¿Qué te interesa?",
    "1) Marcadoras láser",
    "2) Limpiadoras láser",
    "3) Otro",
    "",
    "Responde con 1, 2 o 3."
  ].join("\n");
}

function parseProducto(text) {
  const s = normLow(text);
  if (s === "1" || s.includes("marc")) return "Marcadoras láser";
  if (s === "2" || s.includes("limp")) return "Limpiadoras láser";
  if (s === "3" || s.includes("otro")) return "Otro";
  return null;
}

function askInteres() {
  return [
    "Perfecto. ¿Qué necesitas?",
    "1) DEMO",
    "2) Cotización",
    "3) Recibir más información",
    "",
    "Responde con 1, 2 o 3."
  ].join("\n");
}

function parseInteres(text) {
  const s = normLow(text);
  if (s === "1" || s.includes("demo")) return "DEMO";
  if (s === "2" || s.includes("cot")) return "Cotización";
  if (s === "3" || s.includes("info")) return "Recibir más información";
  return null;
}

function askNombre() {
  return "Gracias. ¿Cuál es tu nombre completo?";
}

function askEmpresa() {
  return "Gracias. ¿Cuál es el nombre de tu empresa o taller?";
}

function askCiudad() {
  return "Perfecto. ¿En qué ciudad/sucursal te gustaría atenderte? (Ej: CDMX, MTY, GDL...)";
}

/**
 * Lógica del bot (rápida).
 * Regresa: { replyText, done, leadData }
 */
function botLogic(wa_id, incomingText) {
  const text = norm(incomingText);

  if (isResetCommand(text)) {
    resetState(wa_id);
    setState(wa_id, { step: "ASK_PRODUCTO", data: {} });
    return { replyText: askProducto(), done: false, leadData: null };
  }

  const st = getState(wa_id);

  if (st.step === "START") {
    setState(wa_id, { step: "ASK_PRODUCTO", data: {} });
    return { replyText: askProducto(), done: false, leadData: null };
  }

  if (st.step === "ASK_PRODUCTO") {
    const producto = parseProducto(text);
    if (!producto) return { replyText: "No entendí 😅 Responde con 1, 2 o 3.\n\n" + askProducto(), done: false, leadData: null };
    st.data.producto = producto;
    setState(wa_id, { step: "ASK_INTERES", data: st.data });
    return { replyText: askInteres(), done: false, leadData: null };
  }

  if (st.step === "ASK_INTERES") {
    const interes = parseInteres(text);
    if (!interes) return { replyText: "No entendí 😅 Responde con 1, 2 o 3.\n\n" + askInteres(), done: false, leadData: null };
    st.data.interes = interes;
    setState(wa_id, { step: "ASK_NOMBRE", data: st.data });
    return { replyText: askNombre(), done: false, leadData: null };
  }

  if (st.step === "ASK_NOMBRE") {
    st.data.nombre = text;
    setState(wa_id, { step: "ASK_EMPRESA", data: st.data });
    return { replyText: askEmpresa(), done: false, leadData: null };
  }

  if (st.step === "ASK_EMPRESA") {
    st.data.empresa = text;
    setState(wa_id, { step: "ASK_CIUDAD", data: st.data });
    return { replyText: askCiudad(), done: false, leadData: null };
  }

  if (st.step === "ASK_CIUDAD") {
    st.data.ciudad = text;

    setState(wa_id, { step: "DONE", data: st.data });

    const leadData = {
      wa_id: String(wa_id || ""),
      telefono: wa_id ? `+${wa_id}` : "",
      producto: String(st.data.producto || ""),
      interes: String(st.data.interes || ""),
      nombre: String(st.data.nombre || ""),
      empresa: String(st.data.empresa || ""),
      ciudad: String(st.data.ciudad || ""),
      created_at_ms: nowMs(),
    };

    return {
      replyText: "Listo ✅ Ya registré tus datos. En breve te contactamos. (Escribe 'menu' para reiniciar)",
      done: true,
      leadData,
    };
  }

  // DONE
  return { replyText: "Ya tengo tus datos ✅. Escribe 'menu' para reiniciar.", done: false, leadData: null };
}

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
    const t0 = Date.now();

    try {
      const body = await readJsonBody();
      console.log("WEBHOOK_EVENT:", JSON.stringify(body, null, 2));

      const entry = body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const msg = value?.messages?.[0];

      // statuses u otros eventos
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
      const text = msg?.text?.body || "";
      const phoneNumberId = value?.metadata?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;

      const waToken = process.env.WHATSAPP_TOKEN;
      if (!waToken || !phoneNumberId || !from) {
        console.log("MISSING_WHATSAPP_DATA:", { hasToken: !!waToken, phoneNumberId, from });
        return send(200, "OK");
      }

      // ✅ 1) Bot rápido (Node decide respuesta)
      const { replyText, done, leadData } = botLogic(from, text);
      console.log("BOT_REPLY:", replyText);
      console.log("TIMER: before_send_ms", Date.now() - t0);

      // ✅ 2) Enviar a WhatsApp (1 mensaje)
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
      console.log("TIMER: after_send_ms", Date.now() - t0);

      // ✅ 3) Guardar en Lark SOLO cuando termine el flujo
      if (done && leadData) {
        try {
          await larkCreateLeadFromLeadData(leadData);
          console.log("LARK_SYNC_OK");
        } catch (e) {
          console.error("LARK_SYNC_ERROR:", e?.message || e);
        }
      } else {
        console.log("LARK_SAVE_SKIP:not_done");
      }

      console.log("TIMER: end_ms", Date.now() - t0);
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

/**
 * ✅ Guardado flexible:
 * - Si defines variables de entorno con nombres EXACTOS de campo de Lark, se rellenan esas columnas.
 * - Si no defines nada, cae a campos "wa_id / created_at / nombre / telefono / mensaje" como antes.
 *
 * Variables opcionales (pon el nombre EXACTO del campo en tu Bitable):
 * - LARK_FIELD_WA_ID
 * - LARK_FIELD_CREATED_AT
 * - LARK_FIELD_PRODUCTO
 * - LARK_FIELD_INTERES
 * - LARK_FIELD_NOMBRE
 * - LARK_FIELD_EMPRESA
 * - LARK_FIELD_CIUDAD
 * - LARK_FIELD_TELEFONO
 *
 * Si no las pones, guardará:
 * - wa_id, created_at, nombre, telefono, mensaje (mensaje contiene todo en texto)
 */
async function larkCreateLeadFromLeadData(lead) {
  const appTokenRaw = process.env.LARK_APP_TOKEN;
  const tableId = process.env.LARK_TABLE_ID;
  if (!appTokenRaw || !tableId) throw new Error("Missing LARK_APP_TOKEN or LARK_TABLE_ID");

  const appToken = String(appTokenRaw).split("?")[0].trim();
  const tenantToken = await larkGetTenantToken();

  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;

  const fields = {};

  // Mapeo por env (si existe)
  const map = (envKey, value) => {
    const fieldName = process.env[envKey];
    if (fieldName && fieldName !== "0") fields[fieldName] = value;
  };

  map("LARK_FIELD_WA_ID", String(lead.wa_id || ""));
  map("LARK_FIELD_CREATED_AT", Number(lead.created_at_ms || Date.now()));
  map("LARK_FIELD_PRODUCTO", String(lead.producto || ""));
  map("LARK_FIELD_INTERES", String(lead.interes || ""));
  map("LARK_FIELD_NOMBRE", String(lead.nombre || ""));
  map("LARK_FIELD_EMPRESA", String(lead.empresa || ""));
  map("LARK_FIELD_CIUDAD", String(lead.ciudad || ""));
  map("LARK_FIELD_TELEFONO", String(lead.telefono || ""));

  // Fallback clásico (por si no pusiste mapeos)
  if (Object.keys(fields).length === 0) {
    fields.wa_id = String(lead.wa_id || "");
    fields.created_at = Number(lead.created_at_ms || Date.now());
    fields.nombre = String(lead.nombre || "");
    fields.telefono = String(lead.telefono || "");
    fields.mensaje = `producto=${lead.producto} | interes=${lead.interes} | empresa=${lead.empresa} | ciudad=${lead.ciudad}`;
  } else {
    // Aun con mapeo, metemos mensaje por si quieres histórico (si existe ese campo)
    map("LARK_FIELD_MENSAJE", `producto=${lead.producto} | interes=${lead.interes} | empresa=${lead.empresa} | ciudad=${lead.ciudad}`);
  }

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
/ /  
 B U I L D _ M A R K E R :  
 W E B H O O K _ F O R C E _ C O M M I T _ 0 0 1  
 