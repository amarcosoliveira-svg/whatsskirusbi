const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

let sock = null;
let qrCode = null;
let isConnected = false;
const AUTH_DIR = path.join(__dirname, 'auth_info');

function clearAuthInfo() {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('Auth info cleared');
  }
}

async function connectToWhatsApp(retryCount = 0) {
  const maxRetries = 5;
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = qr;
        isConnected = false;
        console.log('New QR code generated');
      }

      if (connection === 'close') {
        isConnected = false;
        qrCode = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed. Status: ${statusCode}`);

        if (statusCode === 405 || statusCode === DisconnectReason.loggedOut) {
          console.log('Session invalid, clearing auth and reconnecting...');
          clearAuthInfo();
          setTimeout(() => connectToWhatsApp(0), 10000);
        } else if (retryCount < maxRetries) {
          const delay = Math.min(10000 * (retryCount + 1), 30000);
          console.log(`Reconnecting in ${delay / 1000}s (attempt ${retryCount + 1}/${maxRetries})`);
          setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
        } else {
          console.log('Max retries reached. Clearing auth and restarting...');
          clearAuthInfo();
          setTimeout(() => connectToWhatsApp(0), 30000);
        }
      }

      if (connection === 'open') {
        isConnected = true;
        qrCode = null;
        console.log('Connected to WhatsApp!');
      }
    });
  } catch (error) {
    console.error('Connection error:', error.message);
    if (retryCount < maxRetries) {
      const delay = Math.min(10000 * (retryCount + 1), 30000);
      setTimeout(() => connectToWhatsApp(retryCount + 1), delay);
    }
  }
}

// === ENDPOINTS ===

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, hasQR: !!qrCode });
});

app.get('/qr', async (req, res) => {
  if (qrCode) {
    try {
      const qrImage = await QRCode.toDataURL(qrCode);
      res.send(`
        <html>
        <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp QR</title></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;flex-direction:column;margin:0">
          <img src="${qrImage}" style="width:350px;height:350px"/>
          <p style="color:#fff;margin-top:20px;font-family:sans-serif">Escaneie com WhatsApp → Dispositivos Conectados</p>
          <script>setTimeout(()=>location.reload(),20000)</script>
        </body>
        </html>
      `);
    } catch (e) {
      res.status(500).json({ status: 'error', message: e.message });
    }
  } else if (isConnected) {
    res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#0f0;margin:0"><h1 style="font-family:sans-serif">✅ Conectado!</h1></body></html>');
  } else {
    res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;margin:0;flex-direction:colu
