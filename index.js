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
let retryCount = 0;
const MAX_RETRIES = 3;

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
    browser: ["ClockIn Bot", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr;
      retryCount = 0;
      console.log("📱 QR Code gerado. Acesse GET /qr");
    }

    if (connection === "open") {
      isConnected = true;
      qrCode = null;
      retryCount = 0;
      console.log("✅ WhatsApp conectado!");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Desconectado. Código: ${statusCode}. Tentativa: ${retryCount + 1}/${MAX_RETRIES}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("🚪 Deslogado. Limpando sessão...");
        clearAuthFolder();
        retryCount = 0;
        setTimeout(() => connectWhatsApp(true), 5000);
        return;
      }

      if (statusCode === 405) {
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
          console.log("🛑 Máximo de tentativas atingido. Use POST /reset para tentar novamente.");
          return;
        }
        console.log(`⚠️ Erro 405. Aguardando ${retryCount * 10}s antes de reconectar...`);
        clearAuthFolder();
        setTimeout(() => connectWhatsApp(true), retryCount * 10000);
        return;
      }

      retryCount++;
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => connectWhatsApp(false), 5000);
      }
    }
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", connected: isConnected, retries: retryCount });
});

app.get("/qr", (req, res) => {
  if (isConnected) return res.json({ status: "already_connected" });
  if (!qrCode) return res.json({ status: "no_qr", message: "Aguardando QR code...", retries: retryCount });
  res.json({ status: "pending", qr: qrCode });
});

app.post("/reset", (req, res) => {
  console.log("🔄 Reset manual solicitado.");
  clearAuthFolder();
  isConnected = false;
  qrCode = null;
  retryCount = 0;
  connectWhatsApp(true);
  res.json({ success: true, message: "Sessão resetada. Aguarde novo QR code em /qr" });
});

app.post("/send-whatsapp", async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, error: "phone e message obrigatórios" });
    if (!isConnected || !sock) return res.status(503).json({ success: false, error: "WhatsApp não conectado" });
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  connectWhatsApp(true);
});
