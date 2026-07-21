#!/bin/sh
set -e

# Clear stale Chromium lock files only.
# DO NOT delete .wwebjs_auth — that is the WhatsApp login session.
find /app/.wwebjs_auth -name 'SingletonLock' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonSocket' -delete 2>/dev/null || true
find /app/.wwebjs_auth -name 'SingletonCookie' -delete 2>/dev/null || true

exec node index.js
