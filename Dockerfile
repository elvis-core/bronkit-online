# Bronkit Online — hosted remote MCP server.
# The host builds from this image and injects PORT (and the other env vars in
# DEPLOY.md) at runtime. The app reads PORT at startup; nothing is hardcoded.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install pinned production dependencies from the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code (tests, scripts, and local data are excluded via .dockerignore).
COPY src ./src
COPY config ./config

# Informational only — the actual port comes from the PORT env var at runtime.
EXPOSE 8080

CMD ["node", "src/server.js"]
