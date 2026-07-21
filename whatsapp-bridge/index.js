require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_HEALTH_URL =
  process.env.N8N_HEALTH_URL ||
  String(N8N_WEBHOOK_URL || '').replace(/\/webhook\/.*$/, '/healthz');
const PORT = Number(process.env.PORT || 3001);
const QR_ACCESS_TOKEN = process.env.QR_ACCESS_TOKEN || '';
const ASSETS_UI_TOKEN = process.env.ASSETS_UI_TOKEN || '';
const WEBHOOK_RETRIES = Number(process.env.WEBHOOK_RETRIES || 3);
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || './media');
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || './assets');
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/$/,
  ''
);
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_MB || 15) * 1024 * 1024;
const SEND_MAX_BYTES = Number(process.env.SEND_MAX_MB || 64) * 1024 * 1024;
const MEDIA_TTL_DAYS = Number(process.env.MEDIA_TTL_DAYS || 14);
const JSON_BODY_LIMIT = `${Math.max(4, Math.ceil((SEND_MAX_BYTES / (1024 * 1024)) * 1.4))}mb`;
const ALLOWLIST = (process.env.ALLOWLIST || '')
  .split(',')
  .map((n) => n.replace(/\D/g, ''))
  .filter(Boolean);

/** message ids sent via POST /send → classify as AI */
const bridgeSentIds = new Map();
/** de-dupe message_create / sync duplicates */
const recentlyProcessed = new Map();
/** de-dupe outbound sends when n8n retries (client_msg_id) */
const recentOutbound = new Map();

let latestQr = null;
let whatsappState = 'initializing';
let isInitializing = false;

if (!N8N_WEBHOOK_URL) {
  console.error('Missing N8N_WEBHOOK_URL in .env');
  process.exit(1);
}

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneMap(map, maxAgeMs) {
  const now = Date.now();
  for (const [key, ts] of map.entries()) {
    if (now - ts > maxAgeMs) map.delete(key);
  }
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

async function resolvePeerPhone(msg) {
  // Outbound (from phone/AI): peer is `to`. Inbound: peer is `from`.
  const peerId = msg.fromMe ? msg.to || msg.from : msg.from || '';

  if (typeof client.getContactLidAndPhone === 'function' && peerId) {
    try {
      const results = await client.getContactLidAndPhone([peerId]);
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
    if (contact.id?.user) {
      const phone = normalizePhone(contact.id.user);
      if (phone) return phone;
    }
  } catch {
    // ignore
  }

  if (String(peerId).endsWith('@c.us')) {
    const phone = normalizePhone(peerId);
    if (phone) return phone;
  }

  try {
    const chat = await msg.getChat();
    if (chat?.isGroup) return '';
    const chatUser = chat?.id?.user || '';
    if (String(chatUser).endsWith('@lid')) {
      if (typeof client.getContactLidAndPhone === 'function') {
        const results = await client.getContactLidAndPhone([`${chatUser}@lid`]);
        const entry = results?.[0];
        if (entry?.pn) {
          const phone = normalizePhone(entry.pn);
          if (phone) return phone;
        }
      }
    }
    const digits = String(chatUser || chat?.name || '').replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      const phone = normalizePhone(digits);
      if (phone) return phone;
    }
  } catch {
    // ignore
  }

  return '';
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

function checkApiToken(req, res) {
  if (!QR_ACCESS_TOKEN) return true;
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== QR_ACCESS_TOKEN) {
    res.status(401).json({ error: 'Unauthorized. Provide x-api-token header.' });
    return false;
  }
  return true;
}

function checkAssetsAccess(req, res, { html = false } = {}) {
  if (!ASSETS_UI_TOKEN) {
    const message = 'Assets UI is disabled. Set ASSETS_UI_TOKEN in .env';
    if (html) {
      res.status(503).send(`<h2>${message}</h2>`);
    } else {
      res.status(503).json({ error: message });
    }
    return false;
  }

  const token = req.headers['x-assets-token'] || req.query.token;
  if (token !== ASSETS_UI_TOKEN) {
    const message = 'Unauthorized. Provide ?token=YOUR_ASSETS_UI_TOKEN';
    if (html) {
      res.status(401).send(`<h2>${message}</h2>`);
    } else {
      res.status(401).json({ error: message });
    }
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

function extensionForMime(mimetype) {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  const map = {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/3gpp': '3gp',
    'application/pdf': 'pdf',
  };
  return map[mime] || 'bin';
}

function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.3gp': 'video/3gpp',
  };
  return map[ext] || 'application/octet-stream';
}

function inferMediaType(mimetype, explicitType) {
  const requested = String(explicitType || '').trim().toLowerCase();
  if (['text', 'image', 'audio', 'video', 'document'].includes(requested)) {
    return requested;
  }

  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function assertSendableSize(buffer, label) {
  if (!buffer || buffer.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (buffer.length > SEND_MAX_BYTES) {
    throw new Error(
      `${label} too large (${buffer.length} bytes, max ${SEND_MAX_BYTES} bytes / ${process.env.SEND_MAX_MB || 64} MB)`
    );
  }
}

async function fetchMediaBuffer(url) {
  const headers = {};
  if (QR_ACCESS_TOKEN) headers['x-api-token'] = QR_ACCESS_TOKEN;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch media_url (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimetype = String(response.headers.get('content-type') || '')
    .split(';')[0]
    .trim();

  return { buffer, mimetype };
}

async function resolveOutboundMedia(body) {
  const asset = String(body.asset || '').trim();
  const mediaUrl = String(body.media_url || '').trim();
  const mediaBase64 = String(body.media_base64 || '').trim();
  const requestedFilename = String(body.filename || '').trim();
  const requestedMimetype = String(body.mimetype || '').trim();

  if (asset) {
    const safeName = sanitizeAssetFilename(asset);
    if (!safeName) {
      throw new Error('Invalid asset filename');
    }
    const filePath = path.join(ASSETS_DIR, safeName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Asset not found: ${safeName}`);
    }
    const buffer = fs.readFileSync(filePath);
    const mimetype = requestedMimetype || mimeFromFilename(safeName);
    return {
      buffer,
      mimetype,
      filename: requestedFilename || safeName,
      source: 'asset',
    };
  }

  if (mediaUrl) {
    const fetched = await fetchMediaBuffer(mediaUrl);
    let filename = requestedFilename;
    if (!filename) {
      try {
        filename = path.basename(new URL(mediaUrl).pathname) || 'file';
      } catch {
        filename = 'file';
      }
    }
    return {
      buffer: fetched.buffer,
      mimetype: requestedMimetype || fetched.mimetype || mimeFromFilename(filename),
      filename,
      source: 'media_url',
    };
  }

  if (mediaBase64) {
    if (!requestedMimetype) {
      throw new Error('mimetype is required when using media_base64');
    }
    const buffer = Buffer.from(mediaBase64, 'base64');
    return {
      buffer,
      mimetype: requestedMimetype,
      filename: requestedFilename || `file.${extensionForMime(requestedMimetype)}`,
      source: 'media_base64',
    };
  }

  return null;
}

function buildSendOptions(mediaType, body, captionText) {
  const caption = String(captionText ?? body.message ?? body.caption ?? '').trim();
  const options = {};
  if (caption) options.caption = caption;

  if (mediaType === 'document' || body.send_as_document === true) {
    options.sendMediaAsDocument = true;
  }
  if (mediaType === 'audio' && body.send_as_voice === true) {
    options.sendAudioAsVoice = true;
  }

  return options;
}

function listAssetFiles() {
  try {
    return fs
      .readdirSync(ASSETS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const full = path.join(ASSETS_DIR, entry.name);
        const stat = fs.statSync(full);
        const mimetype = mimeFromFilename(entry.name);
        return {
          name: entry.name,
          size_bytes: stat.size,
          mimetype,
          media_type: inferMediaType(mimetype),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp3',
  '.ogg',
  '.opus',
  '.m4a',
  '.aac',
  '.wav',
  '.webm',
  '.mp4',
  '.mov',
  '.3gp',
]);

function sanitizeAssetFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base.startsWith('.')) return null;

  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = path.extname(safe).toLowerCase();
  if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) return null;

  return safe;
}

const PUBLIC_DIR = path.resolve(__dirname, 'public');

function normalizeMessageType(msg) {
  const type = String(msg.type || 'chat').toLowerCase();
  if (type === 'chat') return 'text';
  if (type === 'ptt') return 'audio';
  return type;
}

function placeholderForType(messageType) {
  if (messageType === 'audio' || messageType === 'ptt') return '[voice note]';
  if (messageType === 'image') return '[image]';
  if (messageType === 'video') return '[video]';
  if (messageType === 'document') return '[document]';
  if (messageType === 'sticker') return '[sticker]';
  return '[media]';
}

function classifySender(msg) {
  if (!msg.fromMe) return 'customer';
  const id = msg.id?._serialized || '';
  if (id && bridgeSentIds.has(id)) return 'ai';
  return 'counselor';
}

async function downloadAndStoreMedia(msg, phone) {
  if (!msg.hasMedia) return null;

  let media;
  try {
    media = await msg.downloadMedia();
  } catch (error) {
    console.warn(`Media download failed (${msg.id?._serialized}):`, error.message);
    return null;
  }

  if (!media?.data) return null;

  const buffer = Buffer.from(media.data, 'base64');
  if (buffer.length > MEDIA_MAX_BYTES) {
    console.warn(
      `Media too large (${buffer.length} bytes) for ${msg.id?._serialized} — skipped save`
    );
    return {
      mimetype: media.mimetype || '',
      filename: '',
      media_url: '',
      size_bytes: buffer.length,
      skipped: true,
      reason: 'too_large',
    };
  }

  const safePhone = normalizePhone(phone) || 'unknown';
  const ext = extensionForMime(media.mimetype);
  const filename = `${Date.now()}_${safePhone}_${String(msg.id?.id || 'msg').slice(-12)}.${ext}`;
  const filePath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  const tokenQuery = QR_ACCESS_TOKEN
    ? `?token=${encodeURIComponent(QR_ACCESS_TOKEN)}`
    : '';

  return {
    mimetype: media.mimetype || '',
    filename,
    media_url: `${MEDIA_BASE_URL}/media/${filename}${tokenQuery}`,
    size_bytes: buffer.length,
    skipped: false,
  };
}

function cleanupOldMedia() {
  const maxAgeMs = MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const full = path.join(MEDIA_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(full);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

async function buildPayload(msg) {
  const phone = await resolvePeerPhone(msg);
  if (!phone) return null;
  if (ALLOWLIST.length > 0 && !ALLOWLIST.includes(phone)) return null;

  const messageType = normalizeMessageType(msg);
  const hasMedia = Boolean(msg.hasMedia);
  const bodyText = String(msg.body || '').trim();
  const sender = classifySender(msg);
  const direction = msg.fromMe ? 'outbound' : 'inbound';

  let whatsappName = '';
  try {
    const contact = await msg.getContact();
    whatsappName = contact.pushname || contact.name || '';
  } catch {
    whatsappName = msg._data?.notifyName || '';
  }

  let mediaInfo = null;
  if (hasMedia) {
    mediaInfo = await downloadAndStoreMedia(msg, phone);
  }

  const message =
    bodyText ||
    (hasMedia ? placeholderForType(messageType) : '');

  if (!message && !hasMedia) return null;

  return {
    phone,
    message,
    timestamp: new Date((msg.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    direction,
    whatsapp_name: whatsappName,
    message_id: msg.id?._serialized || '',
    message_type: messageType,
    has_media: hasMedia,
    mimetype: mediaInfo?.mimetype || '',
    media_filename: mediaInfo?.filename || '',
    media_url: mediaInfo?.media_url || '',
    media_size_bytes: mediaInfo?.size_bytes || 0,
    sender,
    source: 'whatsapp',
    from_me: Boolean(msg.fromMe),
  };
}

async function handleMessageCreate(msg) {
  try {
    if (msg.from?.endsWith?.('@g.us') || msg.to?.endsWith?.('@g.us')) return;
    if (msg.from === 'status@broadcast') return;

    const messageId = msg.id?._serialized || '';
    if (messageId) {
      pruneMap(recentlyProcessed, 5 * 60 * 1000);
      if (recentlyProcessed.has(messageId)) return;
      recentlyProcessed.set(messageId, Date.now());
    }

    // Refresh AI classification window
    pruneMap(bridgeSentIds, 10 * 60 * 1000);

    const payload = await buildPayload(msg);
    if (!payload) {
      if (!msg.fromMe) {
        console.warn(
          `Skipping inbound message — could not resolve phone for from=${msg.from} to=${msg.to} id=${msg.id?._serialized || ''}`
        );
      }
      return;
    }

    const preview =
      payload.message_type === 'text'
        ? payload.message.slice(0, 80)
        : `${payload.message_type}${payload.media_url ? ' +media' : ''}`;
    console.log(`[${payload.direction}/${payload.sender}] ${payload.phone}: ${preview}`);

    await forwardToN8n(payload);
    console.log(`Forwarded to n8n: ${payload.phone} (${payload.sender})`);
  } catch (error) {
    console.error('Failed to process message_create:', error.message);
  }
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
  cleanupOldMedia();
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

// Captures customer + AI (/send) + counselor phone messages
client.on('message_create', handleMessageCreate);

// Backup capture for inbound-only events (some WA Web builds are flaky on message_create)
client.on('message', async (msg) => {
  if (msg.fromMe) return;
  await handleMessageCreate(msg);
});

const app = express();
app.use(express.json({ limit: JSON_BODY_LIMIT }));

async function ensureWhatsAppReady() {
  if (whatsappState !== 'ready' && whatsappState !== 'authenticated') {
    throw new Error('WhatsApp client is not ready');
  }
}

async function sendWhatsAppMessage(phone, message) {
  await ensureWhatsAppReady();

  const digits = normalizePhone(phone);
  if (!digits) throw new Error('Invalid phone number');

  const chatId = `${digits}@c.us`;
  const sent = await client.sendMessage(chatId, message);
  const messageId = sent?.id?._serialized || '';
  if (messageId) {
    bridgeSentIds.set(messageId, Date.now());
  }
  return {
    phone: digits,
    message_id: messageId,
    media_type: 'text',
  };
}

async function sendWhatsAppMedia(phone, mediaPayload, body, captionText = undefined) {
  await ensureWhatsAppReady();

  const digits = normalizePhone(phone);
  if (!digits) throw new Error('Invalid phone number');

  assertSendableSize(mediaPayload.buffer, 'Outbound media');

  const mediaType = inferMediaType(mediaPayload.mimetype, body.media_type);
  const media = new MessageMedia(
    mediaPayload.mimetype,
    mediaPayload.buffer.toString('base64'),
    mediaPayload.filename
  );
  const options = buildSendOptions(mediaType, body, captionText);
  const chatId = `${digits}@c.us`;
  const sent = await client.sendMessage(chatId, media, options);
  const messageId = sent?.id?._serialized || '';
  if (messageId) {
    bridgeSentIds.set(messageId, Date.now());
  }

  return {
    phone: digits,
    message_id: messageId,
    media_type: mediaType,
    mimetype: mediaPayload.mimetype,
    filename: mediaPayload.filename,
    source: mediaPayload.source,
    send_options: options,
  };
}

async function sendWhatsAppTextAndMediaSeparate(phone, message, mediaPayload, body) {
  const gapMs = Number(body.message_gap_ms || 2000);
  const parts = [];

  if (message) {
    parts.push(await sendWhatsAppMessage(phone, message));
    if (gapMs > 0) await sleep(gapMs);
  }

  parts.push(await sendWhatsAppMedia(phone, mediaPayload, body, ''));

  const last = parts[parts.length - 1];
  return {
    phone: last.phone,
    message_id: last.message_id,
    media_type: last.media_type,
    mimetype: last.mimetype,
    filename: last.filename,
    source: last.source,
    separate_messages: true,
    parts_count: parts.length,
  };
}

app.post('/send', async (req, res) => {
  if (!checkApiToken(req, res)) return;

  try {
    const body = req.body || {};
    const phone = body.phone;
    const message = String(body.message || body.caption || '').trim();
    const clientMsgId = String(body.client_msg_id || '').trim();
    const mediaPayload = await resolveOutboundMedia(body);
    const hasMedia = Boolean(mediaPayload);

    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }
    if (!hasMedia && !message) {
      return res.status(400).json({
        error: 'message is required for text sends (or provide asset / media_url / media_base64)',
      });
    }

    if (clientMsgId) {
      pruneMap(recentOutbound, 30 * 60 * 1000);
      const prior = recentOutbound.get(clientMsgId);
      if (prior) {
        return res.json({ ok: true, deduplicated: true, ...prior });
      }
    }

    const result = hasMedia
      ? body.separate_messages === true && message
        ? await sendWhatsAppTextAndMediaSeparate(phone, message, mediaPayload, body)
        : await sendWhatsAppMedia(phone, mediaPayload, body)
      : await sendWhatsAppMessage(phone, message);

    if (clientMsgId) {
      recentOutbound.set(clientMsgId, result);
    }

    const preview = hasMedia
      ? `${result.media_type}:${result.filename || 'media'}`
      : message.slice(0, 80);
    console.log(`Sent WhatsApp ${hasMedia ? 'media' : 'text'} to ${result.phone}: ${preview}`);

    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Send failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/assets', (req, res) => {
  if (!checkAssetsAccess(req, res)) return;
  res.json({
    ok: true,
    assets_dir: ASSETS_DIR,
    send_max_mb: Number(process.env.SEND_MAX_MB || 64),
    files: listAssetFiles(),
  });
});

app.post('/assets/upload', async (req, res) => {
  if (!checkAssetsAccess(req, res)) return;

  try {
    const filename = sanitizeAssetFilename(req.body?.filename);
    const data = String(req.body?.data || '').trim();
    const mimetype =
      String(req.body?.mimetype || '').trim() || mimeFromFilename(filename);

    if (!filename) {
      return res.status(400).json({
        error:
          'Invalid filename or unsupported type. Allowed: PDF, images, audio, video.',
      });
    }
    if (!data) {
      return res.status(400).json({ error: 'data (base64) is required' });
    }

    const buffer = Buffer.from(data, 'base64');
    assertSendableSize(buffer, 'Upload');

    const filePath = path.join(ASSETS_DIR, filename);
    fs.writeFileSync(filePath, buffer);

    const file = {
      name: filename,
      size_bytes: buffer.length,
      mimetype,
      media_type: inferMediaType(mimetype),
    };

    console.log(`Asset uploaded via UI: ${filename} (${buffer.length} bytes)`);
    res.json({ ok: true, file });
  } catch (error) {
    console.error('Asset upload failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/assets/:filename', (req, res) => {
  if (!checkAssetsAccess(req, res)) return;

  const filename = sanitizeAssetFilename(req.params.filename);
  if (!filename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(ASSETS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  fs.unlinkSync(filePath);
  console.log(`Asset deleted via UI: ${filename}`);
  res.json({ ok: true, deleted: filename });
});

app.get('/assets-ui', (req, res) => {
  if (!checkAssetsAccess(req, res, { html: true })) return;
  res.sendFile(path.join(PUBLIC_DIR, 'assets-ui.html'));
});

app.get('/assets/:filename', (req, res) => {
  if (!checkAssetsAccess(req, res)) return;

  const filename = sanitizeAssetFilename(req.params.filename);
  if (!filename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(ASSETS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.sendFile(filePath);
});

app.get('/media/:filename', (req, res) => {
  if (!checkApiToken(req, res)) return;

  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.sendFile(filePath);
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: whatsappState === 'ready' || whatsappState === 'authenticated',
    whatsapp: whatsappState,
    capture: 'message_create',
    media_dir: MEDIA_DIR,
    assets_dir: ASSETS_DIR,
    assets_ui_enabled: Boolean(ASSETS_UI_TOKEN),
    send_supports: ['text', 'image', 'audio', 'video', 'document'],
    send_options: ['separate_messages', 'send_as_voice', 'send_as_document'],
    send_max_mb: Number(process.env.SEND_MAX_MB || 64),
    assets_count: listAssetFiles().length,
  });
});

app.get('/qr', async (req, res) => {
  if (!checkQrAccess(req, res)) return;

  if (whatsappState === 'ready' || whatsappState === 'authenticated') {
    const assetsHint = ASSETS_UI_TOKEN ? '?token=YOUR_ASSETS_UI_TOKEN' : '';
    return res.send(
      `<h2>WhatsApp is already connected.</h2>
       <p><a href="/health">Health</a>${ASSETS_UI_TOKEN ? ` · <a href="/assets-ui${assetsHint}">Media assets</a>` : ''}</p>`
    );
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
    const assetsHint = ASSETS_UI_TOKEN ? '?token=YOUR_ASSETS_UI_TOKEN' : '';
    console.log(`Health: http://0.0.0.0:${PORT}/health`);
    console.log(`QR page: http://0.0.0.0:${PORT}/qr`);
    if (ASSETS_UI_TOKEN) {
      console.log(`Assets UI: http://0.0.0.0:${PORT}/assets-ui${assetsHint}`);
    } else {
      console.log('Assets UI: disabled (set ASSETS_UI_TOKEN in .env)');
    }
    console.log(`Media: ${MEDIA_DIR} via ${MEDIA_BASE_URL}/media/...`);
    console.log(`Assets: ${ASSETS_DIR} (${listAssetFiles().length} file(s))`);
  });

  setInterval(cleanupOldMedia, 6 * 60 * 60 * 1000);

  await waitForN8n();
  await startWhatsAppClient();
}

main().catch((error) => {
  console.error('Fatal startup error:', error.message);
  process.exit(1);
});
