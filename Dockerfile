FROM node:22-slim

WORKDIR /app

# Copy all application files first
COPY . .

# Install node deps locally. This includes @google/gemini-cli in package.json.
# We run this AFTER copy to ensure the local node_modules is the final one.
RUN npm install

# Explicitly ensure gemini-cli is here and get version
RUN ./node_modules/.bin/gemini --version

# Ensure empty temp dir for file injections
RUN mkdir -p temp

# Environments
ENV GEMINI_SETTINGS_JSON="/app/settings.json"
ENV GEMINI_CLI_PATH="/app/node_modules/.bin/gemini"

# Default Command: First generate settings, then start orchestrator
CMD ["sh", "-c", "node scripts/generate_settings.js && node src/index.js"]
