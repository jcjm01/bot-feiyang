// api/webhook.js (Vercel - CommonJS)
// OBJETIVO:
// - Responder desde Node (rápido, 1 mensaje)
// - Apps Script SOLO para guardar (opcional)
// - Lark para guardar Lead cuando el flujo termina

let LARK_CACHE = { token: null, expiresAtMs: 0 };

// Dedupe simple en memoria (sirve por instancia)
const SEEN = new Map(); // msgId -> expiresAt
const SEEN_TTL_MS = 5 * 60 * 1000;

// Estado simple (por instancia). Para producción lo pasaremos a Lark/DB.
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

function normalizeText(t) {
  return String(t || "").trim();
}

function isResetCommand(t) {
  const s = normalizeText(t).toLowerCase();
  return s === "reset" || s === "reiniciar" || s === "menu" || s === "hola";
}

/**
 * Decide la respuesta del bot y actualiza el estado.
 * Regresa: { replyText, shouldSave, leadData }
 */
function botLogic(wa_id, incomingText) {
  const text = normalizeText(incomingText);

  if (isResetCommand(text)) {
    resetState(wa_id);
    setState(wa_id, { step: "ASK_NAME", data: {} });
    return {
      replyText: "¡Hola! ¿Cuál es tu nombre completo?",
      shouldSave: false,
      leadData: null,
    };
  }

  const st = getState(wa_id);

  // START: si alguien escribe algo sin "hola", igual arrancamos
  if (st.step === "START") {
    setState(wa_id, { step: "ASK_NAME", data: {} });
    return {
      replyText: "¡Hola! ¿Cuál es tu nombre completo?",
      shouldSave: false,
      leadData: null,
    };
  }

  if (st.step === "ASK_NAME") {
    st.data.nombre = text;
    setState(wa_id, { step: "ASK_COMPANY", data: st.data });
    return {
      replyText: "Gracias. ¿Cuál es el nombre de tu empresa o taller?",
      shouldSave: false,
      leadData: null,
    };
  }

  if (st.step === "ASK_COMPANY") {
    st.data.empresa = text;
    setState(wa_id, { step: "ASK_BRANCH", data: st.data });
    return {
      replyText: "Perfecto. ¿En qué sucursal te gustaría atenderte? (CDMX / MTY)",
      shouldSave: false,
      leadData: null,
    };
  }

  if (st.step === "ASK_BRANCH") {
    const branchRaw = text.toLowerCase();
    const branch =
      branchRaw.includes("cdmx") ? "CDMX" :
      branchRaw.includes("mty") ? "MTY" :
      text;

    st.data.sucursal = branch;

    // Flujo terminado
    setState(wa_id, { step: "DONE", data: st.data });

    const leadData = {
      wa_id: String(wa_id || ""),
      nombre: String(st.data.nombre || ""),
      empresa: String(st.data.empresa || ""),
      sucursal: String(st.data.sucursal || ""),
      created_at_ms: nowMs(),
    };

    return {
      replyText: "Listo ✅ Ya registré tus datos. En breve te contactamos. (Escribe 'menu' para reiniciar)",
      shouldSave: true,
      leadData,
    };
  }

  // DONE o cualquier otro paso no esperado
  return {
    replyText: "Ya tengo tus datos ✅. Escribe 'menu' si quieres iniciar de nuevo.",
    shouldSave: false,
    leadData: null,
  };
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

      // ✅ (1) Node decide la respuesta (SIN Apps Script)
      const { replyText, shouldSave, leadData } = botLogic(from, text);
      console.log("BOT_REPLY:", replyText);
      console.log("TIMER: before_send_ms", Date.now() - t0);

      // ✅ (2) Enviar respuesta a WhatsApp (1 SOLO mensaje)
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

      // ✅ (3) Guardados (DESPUÉS de enviar WhatsApp)
      // 3A) Guardar en Lark cuando ya terminó el flujo
      if (shouldSave && leadData) {
        try {
          await larkCreateLead({
            wa_id: leadData.wa_id,
            nombre: leadData.nombre,
            telefono: leadData.wa_id ? `+${leadData.wa_id}` : "",
            mensaje: `empresa=${leadData.empresa} | sucursal=${leadData.sucursal}`,
            created_at_ms: leadData.created_at_ms,
          });
          console.log("LARK_SYNC_OK");
        } catch (e) {
          console.error("LARK_SYNC_ERROR:", e?.message || e);
        }

        // 3B) (Opcional) Apps Script SOLO para guardar
        // Requiere que tu Apps Script soporte este formato.
        const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
        const BOT_SHARED_SECRET = process.env.BOT_SHARED_SECRET;
        const USE_APPS_SCRIPT_SAVE = process.env.USE_APPS_SCRIPT_SAVE === "1";

        if (USE_APPS_SCRIPT_SAVE && APPS_SCRIPT_URL && BOT_SHARED_SECRET) {
          try {
            const url =
              APPS_SCRIPT_URL +
              (APPS_SCRIPT_URL.includes("?") ? "&" : "?") +
              "k=" + encodeURIComponent(BOT_SHARED_SECRET);

            const resp = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "save_lead",
                lead: leadData,
                wa_event: body, // por si lo quieres para debug
              }),
            });

            const raw = await resp.text();
            console.log("APPS_SAVE_STATUS:", resp.status);
            console.log("APPS_SAVE_RAW:", raw);
          } catch (e) {
            console.error("APPS_SAVE_ERROR:", e?.message || e);
          }
        } else {
          console.log("APPS_SAVE_SKIP");
        }
      } else {
        console.log("SAVE_SKIP:not_done");
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
