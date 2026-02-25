#!/bin/sh
set -e

echo "[Entrypoint] Syncing settings.json..."
node scripts/generate_settings.js

echo "[Entrypoint] Verifying core patches..."
node scripts/patch-gemini-core.js

# Execute the main command (CMD from Dockerfile)
echo "[Entrypoint] Starting application..."
exec "$@"
