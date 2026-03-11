const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.join(__dirname, 'auth_info');
const MAX_RETRIES = 5;

let sock = null;
let qrCode = null;
let isConnected = false;
let retryCount = 0;

function clearAuthInfo() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('Auth info cleared');
    }
  } catch (err) {
    console.error('Error clearing auth info:', err.message);
  }
}

async function startSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('Connection update:', JSON.stringify({ connection, qr: qr ? 'present' : 'none' }));

      if (qr) {
        qrCode = qr;
        isConnected = false;
        console.log('New QR code received');
      }

      if (connection === 'open') {
        isConnected = true;
        qrCode = null;
        retryCount = 0;
        console.log('WhatsApp connected!');
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log('Connection closed. Status:', statusCode);

        if (statusCode === 405 || statusCode === DisconnectReason.loggedOut) {
          console.log('Session invalid. Clearing auth and restarting...');
          clearAuthInfo();
          qrCode = null;
          retryCount = 0;
          setTimeout(startSocket, 5000);
        } else if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = retryCount * 10000;
          console.log('Retry ' + retryCount + '/' + MAX_RETRIES + ' in ' + delay + 'ms');
          setTimeout(startSocket, delay);
        } else {
          console.log('Max retries reached. Use /reset to restart.');
        }
      }
    });
  } catch (err) {
    console.error('Error starting socket:', err.message);
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      setTimeout(startSocket, retryCount * 10000);
    }
  }
}

app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#0f0;margin:0"><h1 style="font-family:sans-serif">WhatsApp Conectado!</h1></body></html>');
  }
  if (qrCode) {
    try {
      const qrImage = await QRCode.toDataURL(qrCode);
      return res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;margin:0;flex-direction:column"><img src="' + qrImage + '" style="width:300px;height:300px" /><p style="color:#fff;font-family:sans-serif;margin-top:20px">Escaneie o QR Code no WhatsApp</p><script>setTimeout(function(){location.reload()},30000)</script></body></html>');
    } catch (err) {
      return res.status(500).send('Erro ao gerar QR: ' + err.message);
    }
  }
  res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;margin:0;flex-direction:column"><h2 style="font-family:sans-serif">Aguardando QR code...</h2><script>setTimeout(function(){location.reload()},5000)</script></body></html>');
});

app.get('/reset', (req, res) => {
  clearAuthInfo();
  qrCode = null;
  isConnected = false;
  retryCount = 0;
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
  }
  startSocket();
  res.json({ status: 'reset', message: 'Session cleared. Visit /qr for new QR code.' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, hasQR: !!qrCode, retries: retryCount });
});

app.post('/send', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message required' });
    }
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, jid: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  startSocket();
});
