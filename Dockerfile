# Start with a slim node image
FROM node:22-slim

WORKDIR /app

# 1. Copy dependency manifests and scripts for postinstall
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
COPY packages/tool-bridge/package.json ./packages/tool-bridge/package.json

# 2. Install dependencies (this layer won't re-run unless package.json files change)
RUN npm install --omit=dev && npm cache clean --force

# 3. Copy only the necessary source code
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY packages/ ./packages/

# Propagate setup preferences into the build phase for Scorched Earth hardening
ARG GEMINI_DISABLE_TOOLS=false
ARG GEMINI_DISABLE_WEB_SEARCH=false
ENV GEMINI_DISABLE_TOOLS=${GEMINI_DISABLE_TOOLS}
ENV GEMINI_DISABLE_WEB_SEARCH=${GEMINI_DISABLE_WEB_SEARCH}

RUN node scripts/patch-gemini-core.js

# 4. Prepare environment and executable
RUN mkdir -p /root/.gemini && \
    mkdir -p temp && \
    chmod +x scripts/entrypoint.sh

ENV GEMINI_SETTINGS_JSON="/app/settings.json"
ENV GEMINI_CLI_PATH="/app/node_modules/.bin/gemini"
ENV PATH="/app/node_modules/.bin:${PATH}"
ENV NODE_ENV=production

ENTRYPOINT ["/bin/sh", "/app/scripts/entrypoint.sh"]

# Default Command: start orchestrator
CMD ["node", "src/index.js"]
