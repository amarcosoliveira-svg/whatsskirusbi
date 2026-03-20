const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrDataUrl = null;
let isConnected = false;
let connectedPhone = null;
let retryCount = 0;
let blocked405 = false;
let reconnectTimer = null;
let lastError = null;
let bootedAt = new Date().toISOString();
let currentWebhookUrl = process.env.SUPABASE_WEBHOOK_URL || process.env.WEBHOOK_URL || null;
let lastIncomingMessage = null;
let lastWebhookResult = null;
let isConnecting = false;

const logger = pino({ level: "silent" });

// ── helpers ──────────────────────────────────────────────
function clearAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log("🗑️ auth_info removido");
  }
}

function cleanupSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      sock.end?.();
    } catch (_) {}

    try {
      sock.ws?.close?.();
    } catch (_) {}

    sock = null;
  }
}

function normalizePhone(jid = "") {
  return jid.replace(/@s\.whatsapp\.net$/i, "").replace(/@lid$/i, "").replace(/\D/g, "");
}

function extractText(msg) {
  if (!msg) return "";

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.ephemeralMessage?.message?.conversation ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
    msg.ephemeralMessage?.message?.imageMessage?.caption ||
    msg.ephemeralMessage?.message?.videoMessage?.caption ||
    msg.viewOnceMessage?.message?.conversation ||
    msg.viewOnceMessage?.message?.extendedTextMessage?.text ||
    msg.viewOnceMessage?.message?.imageMessage?.caption ||
    msg.viewOnceMessage?.message?.videoMessage?.caption ||
    msg.viewOnceMessageV2?.message?.conversation ||
    msg.viewOnceMessageV2?.message?.extendedTextMessage?.text ||
    msg.viewOnceMessageV2?.message?.imageMessage?.caption ||
    msg.viewOnceMessageV2?.message?.videoMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.title ||
    msg.templateButtonReplyMessage?.selectedId ||
    ""
  );
}

async function postToWebhook(payload) {
  if (!currentWebhookUrl) {
    console.log("⚠️ Webhook não configurado");
    lastWebhookResult = {
      ok: false,
      status: null,
      error: "Webhook não configurado",
      ts: new Date().toISOString(),
    };
    return;
  }

  try {
    console.log(`📡 Encaminhando para webhook: ${currentWebhookUrl}`);
    const resp = await fetch(currentWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const rawText = await resp.text();
    let parsed = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    lastWebhookResult = {
      ok: resp.ok,
      status: resp.status,
      response: parsed,
      ts: new Date().toISOString(),
    };

    if (!resp.ok) {
      console.error(`❌ Webhook respondeu ${resp.status}:`, parsed);
      return;
    }

    console.log("✅ Webhook respondeu:", parsed);
  } catch (err) {
    lastWebhookResult = {
      ok: false,
      status: null,
      error: err.message,
      ts: new Date().toISOString(),
    };
    console.error("❌ Erro ao enviar para webhook:", err.message);
  }
}

// ── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── connect ──────────────────────────────────────────────
async function connectToWhatsApp({ forceNewSession = false } = {}) {
  if (isConnecting) {
    console.log("⏳ Já existe uma conexão em andamento");
    return;
  }

  isConnecting = true;

  try {
    cleanupSocket();

    if (forceNewSession) {
      clearAuthDir();
    }

    if (blocked405) {
      console.log("⛔ Bloqueado por 405. Use /reset-json após aguardar 30 min.");
      return;
    }

    console.log("🔄 Iniciando conexão WhatsApp...");
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["Render WhatsApp Bridge", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 QR Code gerado");
        qrDataUrl = await QRCode.toDataURL(qr);
        isConnected = false;
      }

      if (connection === "open") {
        console.log("✅ WhatsApp conectado!");
        isConnected = true;
        qrDataUrl = null;
        retryCount = 0;
        blocked405 = false;
        connectedPhone = normalizePhone(sock.user?.id || "") || null;
      }

      if (connection === "close") {
        isConnected = false;
        connectedPhone = null;

        const code = lastDisconnect?.error?.output?.statusCode;
        lastError = { code, ts: new Date().toISOString() };
        console.log(`❌ Conexão fechada. Status: ${code}`);

        if (code === 405) {
          retryCount += 1;

          if (retryCount >= 3) {
            blocked405 = true;
            clearAuthDir();
            console.log("⛔ 405 repetido 3x — reconexão PARADA. Aguarde ~30 min e use /reset-json.");
            return;
          }

          const delay = 60_000;
          console.log(`⏳ 405 — tentativa ${retryCount}/3. Reconectando em ${delay / 1000}s...`);
          reconnectTimer = setTimeout(() => {
            connectToWhatsApp({ forceNewSession: true });
          }, delay);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          clearAuthDir();
          console.log("🔒 Logout detectado. Use /reset-json para reconectar.");
          return;
        }

        const delay = Math.min(5000 * (retryCount + 1), 30_000);
        retryCount += 1;
        console.log(`🔄 Reconectando em ${delay / 1000}s...`);
        reconnectTimer = setTimeout(() => {
          connectToWhatsApp({ forceNewSession: false });
        }, delay);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`📨 messages.upsert recebido | type=${type} | total=${messages?.length || 0}`);

      if (type !== "notify") return;

      for (const msg of messages || []) {
        try {
          if (!msg?.key) continue;
          if (msg.key.fromMe) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;

          const from = normalizePhone(msg.key.remoteJid || "");
          const text = extractText(msg.message);

          console.log("📦 payload recebido:", JSON.stringify({
            remoteJid: msg.key.remoteJid,
            fromMe: msg.key.fromMe,
            messageStubType: msg.messageStubType || null,
            hasMessage: !!msg.message,
            extractedText: text,
          }));

          if (!from || !text) {
            console.log("⚠️ Mensagem ignorada por falta de texto ou remetente");
            continue;
          }

          lastIncomingMessage = {
            from,
            text,
            remoteJid: msg.key.remoteJid,
            ts: new Date().toISOString(),
          };

          console.log(`📩 Mensagem de ${from}: ${text}`);

          await postToWebhook({ from, message: text });
        } catch (err) {
          console.error("❌ Erro processando mensagem recebida:", err.message);
        }
      }
    });
  } catch (err) {
    console.error("❌ Falha ao iniciar conexão:", err.message);
    lastError = { code: "BOOT_ERROR", message: err.message, ts: new Date().toISOString() };
  } finally {
    isConnecting = false;
  }
}

// ══════════════════════ ROTAS ══════════════════════

// Health
app.get("/health", (req, res) => res.send("OK"));

app.get("/health-json", (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    phone: connectedPhone,
    blocked405,
    retryCount,
    lastError,
    webhookConfigured: !!currentWebhookUrl,
    webhookUrl: currentWebhookUrl,
    lastIncomingMessage,
    lastWebhookResult,
    bootedAt,
  });
});

// Webhook runtime config
app.post("/set-webhook", (req, res) => {
  const { webhookUrl } = req.body || {};

  if (!webhookUrl || typeof webhookUrl !== "string") {
    return res.status(400).json({ error: "webhookUrl é obrigatório" });
  }

  currentWebhookUrl = webhookUrl.trim();
  console.log("🔗 Webhook atualizado em runtime:", currentWebhookUrl);

  res.json({
    success: true,
    webhookUrl: currentWebhookUrl,
  });
});

// QR
app.get("/qr", (req, res) => {
  if (isConnected) return res.send(`✅ Conectado: ${connectedPhone}`);
  if (qrDataUrl) return res.send(qrDataUrl);
  res.send("Nenhum QR disponível. Use /reset-json para iniciar.");
});

app.get("/qr-json", (req, res) => {
  if (isConnected) return res.json({ connected: true, phone: connectedPhone });
  if (qrDataUrl) return res.json({ connected: false, qr: qrDataUrl });
  res.json({ connected: false, qr: null, message: "Use /reset-json para iniciar conexão." });
});

// Status
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    phone: connectedPhone,
    blocked405,
    retryCount,
    lastError,
    webhookConfigured: !!currentWebhookUrl,
    webhookUrl: currentWebhookUrl,
    lastIncomingMessage,
    lastWebhookResult,
  });
});

// Reset manual
app.get("/reset-json", async (req, res) => {
  blocked405 = false;
  retryCount = 0;
  lastError = null;
  qrDataUrl = null;
  cleanupSocket();
  clearAuthDir();

  console.log("🔁 Reset manual via /reset-json");
  connectToWhatsApp({ forceNewSession: false });

  res.json({
    success: true,
    message: "Sessão resetada. Acesse /qr-json em ~5s para o QR.",
    webhookUrl: currentWebhookUrl,
  });
});

// Reconnect without deleting auth
app.post("/reconnect", async (req, res) => {
  console.log("♻️ Reconexão manual via /reconnect");
  retryCount = 0;
  lastError = null;
  cleanupSocket();
  connectToWhatsApp({ forceNewSession: false });

  res.json({
    success: true,
    message: "Reconexão iniciada",
  });
});

// Envio de mensagem
app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body || {};

  if (!phone || !message) {
    return res.status(400).json({ error: "phone e message são obrigatórios" });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp não conectado" });
  }

  try {
    const jid = phone.includes("@")
      ? phone
      : `${String(phone).replace(/\D/g, "")}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Enviado para ${jid}`);

    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("❌ Erro ao enviar:", err);
    res.status(500).json({ error: err.message });
  }
});

// Compatibilidade com /send
app.post("/send", async (req, res) => {
  req.body.phone = req.body.phone || req.body.to;
  return app._router.handle(req, res, () => {}, "post", "/send-whatsapp");
});

// Disconnect
app.post("/disconnect", async (req, res) => {
  if (sock) {
    try {
      await sock.logout();
    } catch (_) {}
  }

  cleanupSocket();
  isConnected = false;
  connectedPhone = null;
  qrDataUrl = null;

  res.json({ success: true });
});

// ══════════════════════ START ══════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log("⏸️ Aguardando /reset-json para iniciar conexão WhatsApp.");
  console.log(`🔗 Webhook inicial: ${currentWebhookUrl || "não configurado"}`);
});
Passo a passo:

Substitua o index.js inteiro por esse.
No Render, confirme a env WEBHOOK_URL com o endpoint do seu webhook.
Faça Manual Deploy.
Abra https://serverwhatss.onrender.com/health-json e confirme webhookConfigured: true.
Abra https://serverwhatss.onrender.com/reset-json.
Depois abra https://serverwhatss.onrender.com/qr-json, escaneie o QR.
Envie uma mensagem para o número conectado.
Verifique no health-json se lastIncomingMessage e lastWebhookResult foram preenchidos.
Se quiser, eu também te passo o package.json mínimo correto do Render para esse bridge.
