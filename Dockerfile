# Hosted build. The app is a single Node process serving both the API and the
# built frontend (SERVE_APP=1), backed by SQLite on a persistent volume.
#
# Content (words, sentences, graph, audio) is baked into the image at /seed, then
# copied onto the volume on first boot. Learner progress lives only on the volume,
# so redeploying ships new content and code WITHOUT wiping anyone's progress.
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 compiles from source on this base image.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Drop dev dependencies from the shipped node_modules (keeps the native build).
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg is not needed: the hosted STT path posts audio straight to Groq.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

# Seed content: seeded onto the volume once, never read from again at runtime.
COPY data/app.db /seed/app.db
COPY data/media /seed/media

COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV SERVE_APP=1 \
    PORT=8080 \
    APP_DB_PATH=/data/app.db \
    APP_MEDIA_DIR=/data/media \
    APP_USERS_DIR=/data/users \
    SPEND_LEDGER=/data/spend.json

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/index.js"]
