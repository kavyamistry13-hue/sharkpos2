# SHARKPOS 2 API image. Build context is the repository ROOT (it needs ./database for migrations):
#   docker build -f backend/Dockerfile -t sharkpos2-api .
FROM node:22-alpine AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/backend/node_modules backend/node_modules
COPY backend/package.json backend/
COPY backend/src backend/src
COPY database database
RUN chown -R node:node /app
USER node
WORKDIR /app/backend
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
