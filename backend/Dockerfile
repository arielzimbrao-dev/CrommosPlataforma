# syntax=docker/dockerfile:1
#
# Crommos Plataforma — backend (plataforma-api).
# Coolify: Base Directory = backend, Dockerfile = Dockerfile.
# O contexto de build é ESTA pasta; as deps vêm de backend/package-lock.json.

#############################################
# deps: instala a partir do lockfile local
#############################################
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

#############################################
# build: compila o NestJS e poda para deps de produção
#############################################
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json .npmrc ./
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
COPY database/ ./database/

RUN npm run build

ENV NODE_ENV=production
RUN npm ci --omit=dev && npm cache clean --force

#############################################
# production: imagem de runtime mínima
#############################################
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/database ./database

EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
