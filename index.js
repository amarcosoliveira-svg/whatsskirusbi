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

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || process.env.WEBHOOK_URL || null;

const logger = pino({ level: "silent" });

let sock = null;
let qrDataUrl = null;
let isConnected = false;
let connectedPhone = null;
let retryCount = 0;
let blocked405 = false;
let reconnectTimer = null;

// ── helpers ──────────────────────────────────────────────
function clearAuthDir() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log("🗑️  auth_info removido");
  }
}

function cleanupSocket() {
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// ── conexão principal ────────────────────────────────────
async function connectToWhatsApp() {
  if (blocked405) {
    console.log("⛔ Conexão bloqueada (405). Use /reset-json para tentar novamente.");
    return;
  }

  cleanupSocket();

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
      connectedPhone = sock.user?.id?.split(":")[0] || null;
      retryCount = 0;
      blocked405 = false;
    }

    if (connection === "close") {
      isConnected = false;
      connectedPhone = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Conexão fechada. Status: ${code}`);

      // ── 405: WhatsApp bloqueou o pareamento ──
      if (code === 405) {
        retryCount++;
        if (retryCount >= 3) {
          blocked405 = true;
          clearAuthDir();
          console.log("⛔ 405 repetido 3x — reconexão PARADA. Aguarde ~30 min e use /reset-json.");
          return;
        }
        const delay = 60_000; // 60s entre tentativas
        console.log(`⏳ 405 — tentativa ${retryCount}/3. Reconectando em ${delay / 1000}s...`);
        reconnectTimer = setTimeout(connectToWhatsApp, delay);
        return;
      }

      // ── logout / credencial inválida ──
      if (code === DisconnectReason.loggedOut || code === 401) {
        clearAuthDir();
        retryCount = 0;
        reconnectTimer = setTimeout(connectToWhatsApp, 5000);
        return;
      }

      // ── outros erros: backoff simples ──
      retryCount++;
      const delay = Math.min(retryCount * 5000, 60_000);
      console.log(`🔄 Reconectando em ${delay / 1000}s (tentativa ${retryCount})...`);
      reconnectTimer = setTimeout(connectToWhatsApp, delay);
    }
  });

  // ── mensagens recebidas ────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        msg.message?.ephemeralMessage?.message?.conversation ||
        "";

      if (!text || !from) continue;
      console.log(`📩 Mensagem de ${from}: ${text.substring(0, 80)}`);

      if (WEBHOOK_URL) {
        try {
          await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, message: text }),
          });
        } catch (err) {
          console.error("❌ Webhook erro:", err.message);
        }
      }
    }
  });
}

// ── CORS ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── rotas ────────────────────────────────────────────────
app.get("/", (_, res) => res.json({ service: "whatsapp-baileys-server", connected: isConnected }));

app.get("/health", (_, res) => res.send("OK"));
app.get("/health-json", (_, res) =>
  res.json({
    ok: true,
    service: "whatsapp-baileys-server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!WEBHOOK_URL,
    blocked405,
  })
);

app.get("/qr-json", (_, res) =>
  res.json({ connected: isConnected, phone: connectedPhone, qr: qrDataUrl, blocked405 })
);

app.get("/reset-json", async (_, res) => {
  cleanupSocket();
  clearAuthDir();
  isConnected = false;
  connectedPhone = null;
  qrDataUrl = null;
  retryCount = 0;
  blocked405 = false;
  connectToWhatsApp();
  res.json({ success: true, message: "Sessão resetada. Acesse /qr-json para o QR code." });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone e message obrigatórios" });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp não conectado" });

  try {
    const jid = phone.includes("@") ? phone : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectToWhatsApp();
});
