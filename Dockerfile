# syntax=docker/dockerfile:1

# --- Stage 1: build the React client -----------------------------------------
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Stage 2: runtime (server + built client) --------------------------------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Server dependencies only (no dev deps).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source, then the client build from stage 1.
COPY . .
COPY --from=client /app/client/dist ./client/dist

# The app reads PORT from the environment (the host injects it); 3000 is the
# local default. This EXPOSE is documentation only.
EXPOSE 3000
CMD ["node", "server.js"]
