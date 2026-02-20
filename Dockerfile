FROM node:22-slim

WORKDIR /app

# Copy package info and install node deps
COPY package*.json ./
RUN npm install

# Install the Gemini CLI globally
# Tag defaults to `latest` (stable weekly release).
# Override at build time: docker-compose build --build-arg GEMINI_CLI_TAG=preview
ARG GEMINI_CLI_TAG=latest
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_TAG}

# Copy application files
COPY . .

# Ensure empty temp dir for file injections
RUN mkdir -p temp

# Environments
ENV GEMINI_SETTINGS_JSON="/app/settings.json"

# Default Command: First generate settings, then start orchestrator
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
