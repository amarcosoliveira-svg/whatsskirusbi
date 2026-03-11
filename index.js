const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCode = null;

const AUTH_FOLDER = path.join(__dirname, "auth_info");

function clearAuthFolder() {
  if (fs.existsSync(AUTH_FOLDER)) {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    console.log("🗑️ Sessão antiga removida.");
  }
}

async function connectWhatsApp(forceNew = false) {
  if (forceNew) clearAuthFolder();

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr;
      console.log("QR Code gerado. Acesse GET /qr para visualizar.");
    }

    if (connection === "open") {
      isConnected = true;
      qrCode = null;
      console.log("✅ WhatsApp conectado!");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Desconectado. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

      if (statusCode === 405) {
        console.log("⚠️ Sessão inválida (405). Limpando e reconectando...");
        setTimeout(() => connectWhatsApp(true), 3000);
      } else if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(false), 3000);
      }
    }
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", connected: isConnected });
});

app.get("/qr", (req, res) => {
  if (isConnected) return res.json({ status: "already_connected" });
  if (!qrCode) return res.json({ status: "no_qr", message: "Aguardando QR code..." });
  res.json({ status: "pending", qr: qrCode });
});

app.post("/reset", (req, res) => {
  clearAuthFolder();
  isConnected = false;
  qrCode = null;
  connectWhatsApp(true);
  res.json({ success: true, message: "Sessão resetada. Aguarde novo QR code." });
});

app.post("/send-whatsapp", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: "phone e message são obrigatórios" });
    }
    if (!isConnected || !sock) {
      return res.status(503).json({ success: false, error: "WhatsApp não conectado" });
    }
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectWhatsApp(true);
});
