# Stage 1: MCP Server with Playwright
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy AS mcp

WORKDIR /app

# Install Python deps
COPY mcp_server/requirements.txt ./mcp_server/
RUN pip install --no-cache-dir -r mcp_server/requirements.txt

# Browsers are already installed in the base image, but ensure dependencies are aligned
RUN playwright install --with-deps chromium

# Stage 2: Node Orchestrator
FROM node:22-slim

WORKDIR /app

# Copy system dependencies installed by Playwright
COPY --from=mcp /usr/lib /usr/lib
COPY --from=mcp /lib /lib
COPY --from=mcp /etc /etc

# Install Python into the node image so it can run the MCP server
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libnss3 \
    libxss1 \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy python packages
COPY --from=mcp /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=mcp /usr/local/bin /usr/local/bin

COPY package*.json ./
RUN npm install

# Install the Gemini CLI globally — baked into the image at build time.
# Tag defaults to `latest` (stable weekly release).
# Override at build time: docker-compose build --build-arg GEMINI_CLI_TAG=preview
ARG GEMINI_CLI_TAG=latest
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_TAG}

# Copy application files
COPY . .

# Ensure empty temp dir
RUN mkdir -p temp

# Environments
ENV GEMINI_SETTINGS_JSON="/app/settings.json"

# Default Command: First generate settings, then start orchestrator
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
