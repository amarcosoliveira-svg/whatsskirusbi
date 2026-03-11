const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCode = null;

async function connectWhatsApp() {
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
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      }
    }
  });
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", connected: isConnected });
});

// QR Code endpoint
app.get("/qr", (req, res) => {
  if (isConnected) return res.json({ status: "already_connected" });
  if (!qrCode) return res.json({ status: "no_qr", message: "Aguardando QR code..." });
  res.json({ status: "pending", qr: qrCode });
});

// Enviar mensagem WhatsApp
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
  connectWhatsApp();
});
