FROM node:22-alpine

WORKDIR /app

# Install dependencies from the committed lockfile (npm ci) so the published
# image tree matches exactly what CI tested — reproducible builds (P3-9).
# --omit=dev: the server has no build step and ships production deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Run as non-root for security
RUN addgroup -S shenmay && adduser -S shenmay -G shenmay && chown -R shenmay:shenmay /app
USER shenmay

EXPOSE 3001

# Run migrations first, then start the server.
# Migrations are idempotent (IF NOT EXISTS) so this is safe on every restart.
CMD ["sh", "-c", "node db/migrate.js && node src/index.js"]
