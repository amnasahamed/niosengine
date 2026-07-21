#!/bin/sh
set -e

mkdir -p /app/assets /app/media /app/.wwebjs_auth

# Bind mounts from the host often arrive as root:root — fix so node can upload.
chown -R node:node /app/assets /app/media /app/.wwebjs_auth 2>/dev/null || true

# Clear stale Chromium lock files only.
# DO NOT delete .wwebjs_auth — that is the WhatsApp login session.
find /app/.wwebjs_auth -name 'SingletonLock' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonSocket' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonCookie' -delete 2>/dev/null || true

exec runuser -u node -g node -- node index.js
