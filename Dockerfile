# Start with a slim node image
FROM node:22-slim

WORKDIR /app

# 1. Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# 2. Install dependencies (this layer won't re-run unless package.json changes)
RUN npm install --omit=dev && npm cache clean --force

# 3. Copy only the necessary source code
COPY src/ ./src/
COPY scripts/ ./scripts/

# 4. Prepare environment and executable
RUN ./node_modules/.bin/gemini --version && mkdir -p temp

ENV GEMINI_SETTINGS_JSON="/app/settings.json"
ENV GEMINI_CLI_PATH="/app/node_modules/.bin/gemini"
ENV PATH="/app/node_modules/.bin:${PATH}"

# Default Command: First generate settings, then start orchestrator
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
