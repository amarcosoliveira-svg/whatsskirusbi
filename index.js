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
app.use(express.json());

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

const webhookUrl = process.env.SUPABASE_WEBHOOK_URL || process.env.WEBHOOK_URL || null;
const logger = pino({ level: "silent" });

// ── helpers ──────────────────────────────────────────────
function clearAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log("🗑️  auth_info removido");
  }
}

function cleanupSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (sock) {
    try { sock.end(); } catch (_) {}
    sock = null;
  }
}

function extractText(msg) {
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.text ||
    msg.ephemeralMessage?.message?.conversation ||
    ""
  );
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
async function connectToWhatsApp() {
  cleanupSocket();
  clearAuthDir();

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
      connectedPhone = sock.user?.id?.split(":")[0] || null;
    }

    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      lastError = { code, ts: new Date().toISOString() };
      console.log(`❌ Conexão fechada. Status: ${code}`);

      // ── 405 throttle ──
      if (code === 405) {
        retryCount++;
        if (retryCount >= 3) {
          blocked405 = true;
          clearAuthDir();
          console.log("⛔ 405 repetido 3x — reconexão PARADA. Aguarde ~30 min e use /reset-json.");
          return;
        }
        const delay = 60_000;
        console.log(`⏳ 405 — tentativa ${retryCount}/3. Reconectando em ${delay / 1000}s...`);
        reconnectTimer = setTimeout(connectToWhatsApp, delay);
        return;
      }

      // ── logout normal ──
      if (code === DisconnectReason.loggedOut) {
        clearAuthDir();
        console.log("🔒 Logout detectado. Use /reset-json para reconectar.");
        return;
      }

      // ── outros erros: reconecta com backoff ──
      const delay = Math.min(5000 * (retryCount + 1), 30_000);
      retryCount++;
      console.log(`🔄 Reconectando em ${delay / 1000}s...`);
      reconnectTimer = setTimeout(connectToWhatsApp, delay);
    }
  });

  // ── mensagens recebidas ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;
      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text = extractText(msg.message);
      if (!text || !from) continue;
      console.log(`📩 Mensagem de ${from}: ${text}`);
      if (webhookUrl) {
        try {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, message: text }),
          });
          const data = await resp.json();
          console.log("📤 Webhook respondeu:", data);
        } catch (err) {
          console.error("❌ Erro ao enviar para webhook:", err.message);
        }
      }
    }
  });
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
    webhookConfigured: !!webhookUrl,
    bootedAt,
  });
});

// QR
app.get("/qr", (req, res) => {
  if (isConnected) return res.send(`<h2>✅ Conectado: ${connectedPhone}</h2>`);
  if (qrDataUrl) return res.send(`<img src="${qrDataUrl}" />`);
  res.send("<h2>Nenhum QR disponível. Use /reset-json para iniciar.</h2>");
});
app.get("/qr-json", (req, res) => {
  if (isConnected) return res.json({ connected: true, phone: connectedPhone });
  if (qrDataUrl) return res.json({ connected: false, qr: qrDataUrl });
  res.json({ connected: false, qr: null, message: "Use /reset-json para iniciar conexão." });
});

// Status
app.get("/status", (req, res) => {
  res.json({ connected: isConnected, phone: connectedPhone, blocked405, retryCount, lastError });
});

// Reset — ÚNICO ponto de entrada para iniciar/reiniciar conexão
app.get("/reset-json", async (req, res) => {
  blocked405 = false;
  retryCount = 0;
  lastError = null;
  qrDataUrl = null;
  cleanupSocket();
  clearAuthDir();
  console.log("🔁 Reset manual via /reset-json");
  connectToWhatsApp();
  res.json({ success: true, message: "Sessão resetada. Acesse /qr-json em ~5s para o QR." });
});

// Envio de mensagem
app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone e message são obrigatórios" });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp não conectado" });
  try {
    const jid = phone.includes("@") ? phone : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Enviado para ${jid}`);
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("❌ Erro ao enviar:", err);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect
app.post("/disconnect", async (req, res) => {
  if (sock) { try { await sock.logout(); } catch (_) {} }
  cleanupSocket();
  isConnected = false;
  connectedPhone = null;
  qrDataUrl = null;
  res.json({ success: true });
});

// ══════════════════════ START ══════════════════════
// NÃO conecta automaticamente — aguarda /reset-json
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log("⏸️  Aguardando /reset-json para iniciar conexão WhatsApp.");
});
