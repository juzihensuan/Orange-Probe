FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22-alpine AS runtime

RUN apk add --no-cache ca-certificates iputils tini
WORKDIR /app
ENV NODE_ENV=production PORT=4174 DATA_DIR=/app/data

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY agent ./agent
RUN mkdir -p /app/data/history/nodes /app/data/history/services && chown -R node:node /app

USER node
EXPOSE 4174
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:4174/api/health >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
