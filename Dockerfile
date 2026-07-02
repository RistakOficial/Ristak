# Imagen Docker de Ristak para distribución a clientes (sin entregar código fuente).
# Render despliega esta imagen como web service: escucha en 0.0.0.0:$PORT
# y expone GET /health para el health check del instalador.

# --- Build del frontend ---
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY frontend/ ./
# Contrato de render compartido: el frontend lo importa como ../shared desde
# /app/frontend, así que debe vivir en /app/shared antes del build.
COPY shared/ /app/shared/
# VITE_API_URL vacío: el backend sirve el frontend desde el mismo origen
ENV NODE_ENV=production
RUN npm run build

# --- Dependencias del backend ---
FROM node:22-bookworm-slim AS backend-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- Imagen final ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
# Versión generada por el workflow en cada push (v1.0.<build>); la expone
# /health y /api/health y se muestra en el menú de usuario de la app.
ARG APP_VERSION=0.0.0
ENV APP_VERSION=$APP_VERSION
WORKDIR /app

COPY backend/ ./backend/
# El backend importa ../../../shared desde backend/src/services → /app/shared.
COPY shared/ ./shared/
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Render inyecta PORT; 10000 es el default de Render para imágenes
ENV PORT=10000
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/backend
CMD ["node", "src/server.js"]
