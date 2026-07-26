FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose tini unzip
WORKDIR /app
COPY updater/index.js ./index.js

ENV NODE_ENV=production UPDATER_PORT=4180 COMPOSE_FILE=/deployment/docker-compose.yml COMPOSE_PROJECT_NAME=orange-probe DOCKER_CONFIG=/tmp/docker-config
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
