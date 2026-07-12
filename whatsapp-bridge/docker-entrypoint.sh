#!/bin/sh
set -e

# Clear Chromium temp profile and stale lock files only.
# DO NOT delete .wwebjs_auth/session — that is the WhatsApp login session.
rm -rf /tmp/chromium-profile
find /app/.wwebjs_auth -name 'SingletonLock' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonSocket' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonCookie' -delete 2>/dev/null || true

exec node index.js
