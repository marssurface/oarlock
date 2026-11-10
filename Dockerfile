# syntax=docker/dockerfile:1

# ---- build: TypeScript -> dist (the runtime has zero dependencies) ----
FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build

# ---- runtime: only the compiled output and the manifest ----
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY .env.example ./
EXPOSE 4173

# Default: the terminal agent, with extra docker arguments forwarded to it:
#   docker run --rm -it dock-agent
#   docker run --rm dock-agent --once "explain this repo"
# Web UI (overrides the entrypoint):
#   docker run --rm -p 4173:4173 --entrypoint node dock-agent /app/dist/web/server.js --host 0.0.0.0 --port 4173
ENTRYPOINT ["node", "/app/dist/cli.js"]
