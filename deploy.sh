#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "Creating .env from .env.example"
  cp .env.example .env
  echo ""
  echo "IMPORTANT: Edit .env and set strong values for:"
  echo "  - N8N_BASIC_AUTH_PASSWORD"
  echo "  - QR_ACCESS_TOKEN"
  echo ""
  exit 1
fi

# shellcheck disable=SC1091
source .env

if [[ "${N8N_BASIC_AUTH_PASSWORD:-}" == "change-me-strong-password" ]]; then
  echo "Error: Change N8N_BASIC_AUTH_PASSWORD in .env before deploying."
  exit 1
fi

if [[ "${QR_ACCESS_TOKEN:-}" == "change-me-qr-token" || -z "${QR_ACCESS_TOKEN:-}" ]]; then
  echo "Error: Set a real QR_ACCESS_TOKEN in .env before deploying."
  exit 1
fi

if [[ -f scripts/verify.sh ]]; then
  bash scripts/verify.sh
fi

echo "Building and starting containers..."
docker compose up -d --build

echo ""
echo "Services:"
echo "  n8n:      http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo YOUR_SERVER_IP):5678"
echo "  WhatsApp: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo YOUR_SERVER_IP):3001/qr?token=YOUR_TOKEN"
echo ""
echo "Next steps:"
echo "  1. docker compose logs -f whatsapp-bridge"
echo "  2. Open /qr?token=... and scan with WhatsApp"
echo "  3. Import n8n/whatsapp-crm-workflow.json and activate it"
echo "  4. Add OpenAI + Google Sheets credentials in n8n"
