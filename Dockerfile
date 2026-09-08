FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only the runtime dep (ws) — wrangler is a devDependency and is not needed to serve.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY src ./src
COPY server ./server
COPY public ./public

EXPOSE 8080
CMD ["node", "server/node.js"]
