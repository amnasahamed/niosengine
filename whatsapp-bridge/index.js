require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_HEALTH_URL =
  process.env.N8N_HEALTH_URL ||
  String(N8N_WEBHOOK_URL || '').replace(/\/webhook\/.*$/, '/healthz');
const PORT = Number(process.env.PORT || 3001);
const QR_ACCESS_TOKEN = process.env.QR_ACCESS_TOKEN || '';
const WEBHOOK_RETRIES = Number(process.env.WEBHOOK_RETRIES || 3);
const ALLOWLIST = (process.env.ALLOWLIST || '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

let latestQr = null;
let whatsappState = 'initializing';
let isInitializing = false;

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL in .env');
  process.exit(1);
}

function normalizePhone(raw) {
  const digits = String(raw || '')
    .replace('@c.us', '')
    .replace('@g.us', '')
    .replace('@lid', '')
    .replace(/\D/g, '');

  if (!digits) return '';
  // LIDs are very long internal IDs — never treat them as phone numbers
  if (digits.length > 13) return '';
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

async function resolvePhone(msg) {
  const from = msg.from || '';

  if (typeof client.getContactLidAndPhone === 'function') {
    try {
      const results = await client.getContactLidAndPhone([from]);
      const entry = results?.[0];
      if (entry?.pn) {
        const phone = normalizePhone(entry.pn);
        if (phone) return phone;
      }
    } catch (error) {
      console.warn('getContactLidAndPhone failed:', error.message);
    }
  }

  try {
    const contact = await msg.getContact();
    if (contact.number) {
      const phone = normalizePhone(contact.number);
      if (phone) return phone;
    }
  } catch {
    // ignore
  }

  if (from.endsWith('@c.us')) {
    const phone = normalizePhone(from);
    if (phone) return phone;
  }

  try {
    const chat = await msg.getChat();
    const digits = String(chat?.name || '').replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      const phone = normalizePhone(digits);
      if (phone) return phone;
    }
  } catch {
    // ignore
  }

  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkQrAccess(req, res) {
  if (!QR_ACCESS_TOKEN) return true;
  const token = req.query.token || req.headers['x-qr-token'];
  if (token !== QR_ACCESS_TOKEN) {
    res.status(401).send('Unauthorized. Provide ?token=YOUR_QR_ACCESS_TOKEN');
    return false;
  }
  return true;
}

async function waitForN8n(maxAttempts = 60) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(N8N_HEALTH_URL, { method: 'GET' });
      if (response.ok) {
        console.log(`n8n is ready (${N8N_HEALTH_URL})`);
        return;
      }
    } catch {
      // retry
    }
    console.log(`Waiting for n8n... (${attempt}/${maxAttempts})`);
    await sleep(5000);
  }
  throw new Error(`n8n not reachable at ${N8N_HEALTH_URL}`);
}

async function forwardToN8n(payload) {
  let lastError;

  for (let attempt = 1; attempt <= WEBHOOK_RETRIES; attempt += 1) {
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`n8n webhook failed (${response.status}): ${text}`);
      }

      return response.json().catch(() => ({}));
    } catch (error) {
      lastError = error;
      if (attempt < WEBHOOK_RETRIES) {
        console.warn(`Webhook attempt ${attempt} failed, retrying...`);
        await sleep(2000 * attempt);
      }
    }
  }

  throw lastError;
}

function cleanStaleLocksOnly() {
  // Only remove Chromium lock files — NEVER delete .wwebjs_auth (that logs WhatsApp out)
  const tmpProfile = '/tmp/chromium-profile';
  if (fs.existsSync(tmpProfile)) {
    try {
      fs.rmSync(tmpProfile, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  cleanChromiumLocks();
}

async function destroyClient() {
  try {
    await client.destroy();
  } catch {
    // ignore
  }
  isInitializing = false;
  cleanStaleLocksOnly();
}

function cleanChromiumLocks() {
  const authDir = path.resolve('./.wwebjs_auth');
  const lockNames = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of lockNames) {
      const lockPath = path.join(dir, name);
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          console.log(`Removed stale Chromium lock: ${lockPath}`);
        } catch {
          // ignore
        }
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }

  walk(authDir);
}

const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
];

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './.wwebjs_auth',
    clientId: 'niostech-whatsapp',
  }),
  puppeteer: {
    headless: true,
    userDataDir: '/tmp/chromium-profile',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: puppeteerArgs,
  },
});

async function startWhatsAppClient() {
  if (isInitializing) return;
  isInitializing = true;
  cleanStaleLocksOnly();
  try {
    await client.initialize();
  } catch (error) {
    whatsappState = 'error';
    console.error('WhatsApp initialize failed:', error.message);
    await destroyClient();
    setTimeout(() => {
      console.log('Retrying WhatsApp connection...');
      startWhatsAppClient();
    }, 15000);
  }
}

client.on('qr', (qr) => {
  latestQr = qr;
  whatsappState = 'qr_required';
  isInitializing = false;
  console.log('\nScan QR at /qr or check docker logs:\n');
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
  latestQr = null;
  whatsappState = 'ready';
  isInitializing = false;
  console.log('WhatsApp client is ready.');
});

client.on('authenticated', () => {
  whatsappState = 'authenticated';
  console.log('WhatsApp authenticated.');
});

client.on('disconnected', (reason) => {
  whatsappState = 'disconnected';
  latestQr = null;
  console.error('WhatsApp disconnected:', reason);
  setTimeout(async () => {
    console.log('Reconnecting WhatsApp...');
    await destroyClient();
    startWhatsAppClient();
  }, 10000);
});

client.on('auth_failure', (msg) => {
  whatsappState = 'auth_failure';
  isInitializing = false;
  console.error('WhatsApp auth failed:', msg);
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;
    if (!msg.body?.trim()) return;

    const phone = await resolvePhone(msg);
    if (!phone) {
      console.warn(`Skipping message — could not resolve real phone for ${msg.from}`);
      return;
    }
    if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(phone)) return;

    let whatsappName = '';
    try {
      const contact = await msg.getContact();
      whatsappName = contact.pushname || contact.name || '';
    } catch {
      whatsappName = msg._data?.notifyName || '';
    }

    const payload = {
      phone,
      message: msg.body.trim(),
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
      direction: 'inbound',
      whatsapp_name: whatsappName,
      message_id: msg.id._serialized,
    };

    console.log(`[${phone}] ${payload.message.slice(0, 80)}`);
    await forwardToN8n(payload);
    console.log(`Forwarded to n8n: ${phone}`);
  } catch (error) {
    console.error('Failed to process message:', error.message);
  }
});

const app = express();
app.use(express.json());

function checkApiToken(req, res) {
  if (!QR_ACCESS_TOKEN) return true;
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== QR_ACCESS_TOKEN) {
    res.status(401).json({ error: 'Unauthorized. Provide x-api-token header.' });
    return false;
  }
  return true;
}

async function sendWhatsAppMessage(phone, message) {
  if (whatsappState !== 'ready' && whatsappState !== 'authenticated') {
    throw new Error('WhatsApp client is not ready');
  }

  const digits = normalizePhone(phone);
  if (!digits) throw new Error('Invalid phone number');

  const chatId = `${digits}@c.us`;
  await client.sendMessage(chatId, message);
  return digits;
}

app.post('/send', async (req, res) => {
  if (!checkApiToken(req, res)) return;

  try {
    const { phone, message } = req.body || {};
    if (!phone || !String(message || '').trim()) {
      return res.status(400).json({ error: 'phone and message are required' });
    }

    const sentTo = await sendWhatsAppMessage(phone, String(message).trim());
    console.log(`Sent WhatsApp message to ${sentTo}`);
    res.json({ ok: true, phone: sentTo });
  } catch (error) {
    console.error('Send failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: whatsappState === 'ready' || whatsappState === 'authenticated',
    whatsapp: whatsappState,
  });
});

app.get('/qr', async (req, res) => {
  if (!checkQrAccess(req, res)) return;

  if (whatsappState === 'ready' || whatsappState === 'authenticated') {
    return res.send('<h2>WhatsApp is already connected.</h2><p><a href="/health">Health</a></p>');
  }

  if (!latestQr) {
    return res.send(
      '<h2>Waiting for QR code...</h2><p>Refresh this page in a few seconds.</p><script>setTimeout(()=>location.reload(),5000)</script>'
    );
  }

  const dataUrl = await QRCode.toDataURL(latestQr);
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp QR Login</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 40px auto; text-align: center; }
    img { width: 320px; height: 320px; }
    p { color: #444; }
  </style>
</head>
<body>
  <h1>Scan with WhatsApp</h1>
  <p>Open WhatsApp → Linked devices → Link a device</p>
  <img src="${dataUrl}" alt="WhatsApp QR code" />
  <p>Page auto-refreshes every 20s while waiting.</p>
  <script>setTimeout(()=>location.reload(),20000)</script>
</body>
</html>`);
});

async function main() {
  app.listen(PORT, () => {
    console.log(`Health: http://0.0.0.0:${PORT}/health`);
    console.log(`QR page: http://0.0.0.0:${PORT}/qr`);
  });

  await waitForN8n();
  await startWhatsAppClient();
}

main().catch((error) => {
  console.error('Fatal startup error:', error.message);
  process.exit(1);
});
