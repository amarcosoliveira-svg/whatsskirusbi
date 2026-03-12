const express = require("express");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

let sock = null;
let isConnected = false;
let qrCode = null;
let retryCount = 0;
const MAX_RETRIES = 5;
const AUTH_DIR = path.join(__dirname, "auth_info");

function clearAuthInfo() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("Auth info cleared");
    }
  } catch (e) {
    console.error("Error clearing auth:", e.message);
  }
}

async function connectWhatsApp() {
  if (retryCount >= MAX_RETRIES) {
    console.log("Max retries reached. Use /reset to try again.");
    return;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");
    const { version } = await fetchLatestBaileysVersion();
    console.log("Using WA version:", version);

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrCode = qr;
        retryCount = 0;
        console.log("QR Code generated. Access GET /qr");
      }

      if (connection === "open") {
        isConnected = true;
        qrCode = null;
        retryCount = 0;
        console.log("✅ WhatsApp connected!");
      }

      if (connection === "close") {
        isConnected = false;
        qrCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorData = lastDisconnect?.error;
        console.log(`❌ Disconnected. Code: ${statusCode}, Error: ${errorData?.message}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out. Clearing session...");
          clearAuthInfo();
        }

        retryCount++;
        const delay = Math.min(retryCount * 5000, 30000);
        console.log(`Reconnecting in ${delay / 1000}s (attempt ${retryCount}/${MAX_RETRIES})`);
        setTimeout(connectWhatsApp, delay);
      }
    });
  } catch (err) {
    console.error("connectWhatsApp error:", err.message);
    retryCount++;
    if (retryCount < MAX_RETRIES) {
      setTimeout(connectWhatsApp, retryCount * 5000);
    }
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connected: isConnected,
    hasQR: !!qrCode,
    retries: retryCount,
    maxRetries: MAX_RETRIES,
  });
});

app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send("<h1>✅ WhatsApp Connected!</h1>");
  }
  if (!qrCode) {
    return res.send(`
      <h2>Aguardando QR Code...</h2>
      <p>Tentativa ${retryCount}/${MAX_RETRIES}</p>
      <meta http-equiv="refresh" content="5">
    `);
  }
  try {
    const imgUrl = await QRCode.toDataURL(qrCode);
    res.send(`
      <h2>Escaneie o QR Code no WhatsApp</h2>
      <img src="${imgUrl}" />
      <p>Atualiza automaticamente em 30s</p>
      <meta http-equiv="refresh" content="30">
    `);
  } catch (e) {
    res.status(500).send("Error generating QR image");
  }
});

app.get("/reset", (req, res) => {
  clearAuthInfo();
  retryCount = 0;
  qrCode = null;
  isConnected = false;
  if (sock) {
    try { sock.end(); } catch (_) {}
    sock = null;
  }
  setTimeout(connectWhatsApp, 2000);
  res.json({ status: "reset", message: "Session cleared. Reconnecting in 2s..." });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "phone and message required" });
  if (!isConnected || !sock) return res.status(503).json({ error: "WhatsApp not connected" });

  try {
    const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text: message });
    res.json({ status: "sent", to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  connectWhatsApp();
});
