const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let webhookUrl = process.env.WEBHOOK_URL || null;

// Logger silencioso
const logger = pino({ level: "silent" });

async function startSock() {
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
      qrCodeData = await QRCode.toDataURL(qr);
      isConnected = false;
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `❌ Conexão fechada. Status: ${statusCode}. Reconectando: ${shouldReconnect}`
      );
      if (shouldReconnect) {
        setTimeout(startSock, 3000);
      } else {
        // Limpa credenciais se deslogou
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
        qrCodeData = null;
        setTimeout(startSock, 3000);
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      isConnected = true;
      qrCodeData = null;
      connectedPhone = sock.user?.id?.split(":")[0] || null;
    }
  });

  // Listener de mensagens recebidas
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Ignora mensagens do próprio bot e de status
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text || !from) continue;

      console.log(`📩 Mensagem de ${from}: ${text}`);

      // Encaminhar para o webhook
      if (webhookUrl) {
        try {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, message: text }),
          });
          const data = await resp.json();
          console.log(`📤 Webhook respondeu:`, data);
        } catch (err) {
          console.error("❌ Erro ao enviar para webhook:", err.message);
        }
      } else {
        console.log("⚠️ Webhook não configurado. Mensagem ignorada.");
      }
    }
  });
}

// ==================== ROTAS ====================

// Health check
app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
  });
});

// Retorna QR Code ou status de conexão
app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, phone: connectedPhone });
  }
  if (qrCodeData) {
    return res.json({ qr: qrCodeData });
  }
  res.json({ connected: false, qr: null, message: "Aguardando QR Code..." });
});

// Status da conexão
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : "disconnected",
    phone: connectedPhone,
    webhookUrl: webhookUrl,
  });
});

// Configura o webhook URL
app.post("/set-webhook", (req, res) => {
  const { webhookUrl: url } = req.body;
  if (!url) return res.status(400).json({ error: "webhookUrl is required" });
  webhookUrl = url;
  console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  res.json({ success: true, webhookUrl });
});

// Envia mensagem
app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    // Normaliza o número (adiciona @s.whatsapp.net se necessário)
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensagem enviada para ${jid}`);
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: err.message });
  }
});

// Desconecta o WhatsApp
app.post("/disconnect", async (req, res) => {
  if (sock) {
    await sock.logout();
    isConnected = false;
    connectedPhone = null;
    qrCodeData = null;
  }
  res.json({ success: true, message: "Disconnected" });
});

// Força reconexão (gera novo QR)
app.post("/reconnect", async (req, res) => {
  if (sock) {
    try { sock.end(); } catch (e) {}
  }
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true });
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  startSock();
  res.json({ success: true, message: "Reconnecting... Check /qr for QR code" });
});

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  startSock();
});
E o package.json:


{
  "name": "whatsapp-baileys-server",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.16",
    "express": "^4.21.2",
    "qrcode": "^1.5.4",
    "pino": "^9.6.0"
  }
}
