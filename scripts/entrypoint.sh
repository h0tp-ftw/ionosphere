#!/bin/sh
set -e

echo "[Entrypoint] Syncing settings.json..."
node scripts/generate_settings.js

echo "[Entrypoint] Verifying core patches..."
node scripts/patch-gemini-core.js

# Prevent process pooling from aggressively racing to create projects.json
if [ ! -f /root/.gemini/projects.json ]; then
    mkdir -p /root/.gemini
    echo '{"projects":{}}' > /root/.gemini/projects.json
fi

# Execute the main command (CMD from Dockerfile)
echo "[Entrypoint] Starting application..."
exec "$@"
