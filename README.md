# WhatsApp → n8n → Google Sheets CRM

Automatically capture WhatsApp messages, extract intent with GPT-4o, and update your Google Sheet CRM.

## Architecture

```
WhatsApp Web.js (bridge) ──POST──► n8n /webhook/whatsapp-crm
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
              Data Table          GPT-4o extract      Google Sheets
           (all messages)         (intent + fields)    (CRM upsert)
```

| Component | Role |
|-----------|------|
| `whatsapp-bridge` | Connects to WhatsApp Web, forwards inbound messages to n8n |
| `n8n` workflow | Validates, stores history, calls GPT-4o, upserts CRM row |
| Google Sheet | One row per lead, matched by `Phone` |
| n8n Data Table | Full message log per phone (last 20 used for AI context) |

**Google Sheet:** [Your CRM](https://docs.google.com/spreadsheets/d/10zXMy_k8mbLlrKRU8o5ug3gd06jZ0KqZRWsoKOa2BA4/edit)

**Sheet row 1 headers must match exactly:**
`Lead ID | Date | Student Name | Phone | Alternate Phone | Class/Level | Stream | Subjects Failed | Subjects Count | Source | Price Disclosed | Lead Status | Lost Reason | Assigned To | Last Contacted | Next Follow-up | Follow-ups Count | Days Since Last | Stale? | Remarks`

---

## GitHub → Hostinger deploy

### Before pushing (on your Mac)

```bash
cd /Users/amnasahamed/Desktop/niostech
bash scripts/verify.sh    # must pass
git init
git add .
git commit -m "WhatsApp CRM automation with n8n and Docker"
git remote add origin https://github.com/amnasahamed/niosengine.git
git push -u origin main
```

**Never commit:** `.env`, `node_modules/`, `.wwebjs_auth/`

### On Hostinger VPS (after pull)

```bash
git clone https://github.com/amnasahamed/niosengine.git /opt/niosengine
cd /opt/niosengine
cd /opt/niostech
cp .env.example .env
nano .env          # set passwords + domain
./deploy.sh
```

---

## Part 1 — n8n setup

### 1. Create Data Table

In n8n: **Data → Tables → Create table** named `whatsapp_messages` with columns:

| Column | Type |
|--------|------|
| phone | Text |
| message | Text |
| timestamp | Text |
| direction | Text |
| whatsapp_name | Text |
| message_id | Text |

### 2. Import workflow

1. n8n → **Workflows → Import from file**
2. Select `n8n/whatsapp-crm-workflow.json`
3. Assign credentials on these nodes:
   - **GPT-4o Extract** → OpenAI API credential
   - **Read CRM Sheet** + **Upsert CRM Lead** → Google Sheets OAuth2

### 3. Google Sheets credential

1. Connect your Google account in n8n
2. Share the sheet with that Google account (Editor access)
3. If your tab is not named `Sheet1`, rename **sheetName** on both Google Sheets nodes

### 4. Activate workflow

1. Toggle workflow **Active**
2. With Docker, the bridge already calls `http://n8n:5678/webhook/whatsapp-crm` internally — no change needed

### 5. Sheet formulas (optional, recommended)

Add these in row 2 and drag down — n8n won't write them:

| Column | Formula |
|--------|---------|
| Days Since Last | `=IF(O2="","",TODAY()-O2)` |
| Stale? | `=IF(R2="","",IF(R2>7,"Yes","No"))` |

*(Adjust column letters if your layout differs.)*

---

## Docker on Hostinger (recommended)

Run **n8n + WhatsApp bridge** together on your Linux VPS.

### 1. Upload project to server

```bash
# On your Mac — copy to Hostinger VPS
scp -r /Users/amnasahamed/Desktop/niostech user@YOUR_SERVER_IP:/opt/niostech
```

Or clone/git push if you use a repo.

### 2. Configure environment

```bash
ssh user@YOUR_SERVER_IP
cd /opt/niostech
cp .env.example .env
nano .env
```

Set these in `.env`:

| Variable | Example |
|----------|---------|
| `N8N_HOST` | `n8n.yourdomain.com` |
| `N8N_PROTOCOL` | `https` |
| `WEBHOOK_URL` | `https://n8n.yourdomain.com/` |
| `N8N_BASIC_AUTH_PASSWORD` | strong password |
| `QR_ACCESS_TOKEN` | random secret (protects `/qr`) |
| `N8N_WEBHOOK_URL` | leave `http://n8n:5678/webhook/whatsapp-crm` |

`N8N_WEBHOOK_URL` stays on the **internal Docker network** — the bridge talks to n8n inside Docker, not via the public URL.

### 3. Start containers

```bash
./deploy.sh
# or
docker compose up -d --build
```

Check status:

```bash
docker compose ps
docker compose logs -f whatsapp-bridge
```

### 4. Link WhatsApp (first time only)

Open in browser:

```
http://YOUR_SERVER_IP:3001/qr?token=YOUR_QR_ACCESS_TOKEN
```

Scan with WhatsApp → **Linked devices** → **Link a device**.

Session is saved in Docker volume `whatsapp_auth` — survives restarts.

### 5. n8n setup (same as before)

1. Open n8n: `http://YOUR_SERVER_IP:5678` (or your domain)
2. Create Data Table `whatsapp_messages`
3. Import `n8n/whatsapp-crm-workflow.json`
4. Add OpenAI + Google Sheets credentials
5. **Activate** workflow

### 6. Production: nginx + SSL (Hostinger)

Use `nginx/hostinger.conf.example` as a template:

```bash
sudo cp nginx/hostinger.conf.example /etc/nginx/sites-available/niostech
sudo nano /etc/nginx/sites-available/niostech   # replace yourdomain.com
sudo ln -s /etc/nginx/sites-available/niostech /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d n8n.yourdomain.com -d whatsapp.yourdomain.com
```

After SSL, update `.env`:

```
N8N_PROTOCOL=https
WEBHOOK_URL=https://n8n.yourdomain.com/
```

Then restart:

```bash
docker compose up -d
```

### Docker commands cheat sheet

```bash
docker compose logs -f n8n
docker compose logs -f whatsapp-bridge
docker compose restart whatsapp-bridge
docker compose down
docker volume ls   # n8n_data + whatsapp_auth persist data
```

### Re-link WhatsApp (if session expires)

```bash
docker compose stop whatsapp-bridge
docker volume rm niostech_whatsapp_auth   # name may vary: docker volume ls
docker compose up -d whatsapp-bridge
# Open /qr and scan again
```

---

## Part 2 — WhatsApp bridge (local, without Docker)

This small Node.js app connects to WhatsApp Web and forwards messages to n8n.

```bash
cd whatsapp-bridge
cp .env.example .env
# Edit .env — paste your n8n Production webhook URL
npm install
npm start
```

1. Scan the QR code with WhatsApp on your phone
2. Send a test message to that WhatsApp number
3. Check n8n **Executions** — you should see a successful run
4. Check your Google Sheet — a new row should appear

### Health check

```bash
curl http://localhost:3001/health
```

---

## What GPT-4o extracts per message

| CRM column | How it's filled |
|------------|-----------------|
| Lead ID | `WA-{phone}` (kept on updates) |
| Date | Today (only for new leads) |
| Student Name | From message or WhatsApp name |
| Phone | Sender number |
| Class/Level, Stream | From conversation |
| Subjects Failed / Count | Parsed from message |
| Source | `WhatsApp` |
| Price Disclosed | If fees discussed |
| Lead Status | From intent (New, Interested, Follow-up, Lost…) |
| Last Contacted | Message date |
| Next Follow-up | If they say "call tomorrow" etc. |
| Follow-ups Count | +1 each message |
| Remarks | AI summary of full chat |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Webhook 404 | Workflow must be **Active**; path must be `whatsapp-crm` |
| Duplicate leads in sheet | Phone column must use consistent format; workflow normalizes to `91XXXXXXXXXX` |
| Google Sheets permission denied | Share sheet with n8n Google account |
| QR keeps appearing | `docker volume rm niostech_whatsapp_auth` then re-scan |
| Wrong sheet tab | Change `Sheet1` on Read + Upsert nodes |
| n8n can't reach bridge | In Docker, bridge uses internal URL `http://n8n:5678/webhook/whatsapp-crm` |
| QR not visible in Docker | Open `http://SERVER:3001/qr?token=YOUR_QR_ACCESS_TOKEN` |
| Chromium crash in Docker | `shm_size: 512mb` is set; `docker compose restart whatsapp-bridge` |
| WhatsApp disconnects | Bridge auto-reconnects; re-scan QR if session expired |
| Bridge starts before n8n | Fixed: n8n healthcheck + `depends_on: service_healthy` |

---

## Running 24/7

On Hostinger, Docker handles this (`restart: unless-stopped` in `docker-compose.yml`).

For local (non-Docker) installs:

```bash
cd whatsapp-bridge
npm install -g pm2
pm2 start index.js --name whatsapp-bridge
pm2 save
```

---

## Next steps (when you're ready)

- Auto-replies for fee inquiries
- Assign leads round-robin to counselors
- Daily stale-lead alerts
- Debounce rapid messages (Wait node, 45s)
