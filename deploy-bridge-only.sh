#!/usr/bin/env bash
# Deploy WhatsApp bridge only — when n8n + Traefik already run on this server.
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  if [[ -f .env.bridge.example ]]; then
    cp .env.bridge.example .env
  else
    cp .env.example .env
  fi
  echo "Created .env — set QR_ACCESS_TOKEN and ASSETS_UI_TOKEN then run again."
  exit 1
fi

# shellcheck disable=SC1091
source .env

if [[ "${QR_ACCESS_TOKEN:-}" == "change-me-qr-token" || -z "${QR_ACCESS_TOKEN:-}" ]]; then
  echo "Error: Set QR_ACCESS_TOKEN in .env"
  exit 1
fi

if [[ "${ASSETS_UI_TOKEN:-}" == "skillvard-assets-k9mP2xQ7" || -z "${ASSETS_UI_TOKEN:-}" ]]; then
  echo "Error: Set ASSETS_UI_TOKEN in .env (use a unique URL-safe token)"
  exit 1
fi

if ! docker network inspect n8n_default >/dev/null 2>&1; then
  echo "Error: Docker network 'n8n_default' not found."
  echo "Run: docker network ls"
  echo "Then set the correct network name in docker-compose.bridge-only.yml"
  exit 1
fi

echo "Building and starting WhatsApp bridge (existing n8n unchanged)..."
docker compose -f docker-compose.bridge-only.yml up -d --build

echo ""
echo "Done. Next:"
echo "  1. docker compose -f docker-compose.bridge-only.yml logs -f"
echo "  2. Open http://YOUR_SERVER_IP:3001/qr?token=YOUR_QR_ACCESS_TOKEN"
echo "  3. Media assets UI: http://YOUR_SERVER_IP:3001/assets-ui?token=YOUR_ASSETS_UI_TOKEN"
echo "  4. Import workflow in your EXISTING n8n UI and activate it"
