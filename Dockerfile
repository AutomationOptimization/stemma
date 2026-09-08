FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# `ws` is the only runtime dependency — wrangler and miniflare are devDependencies used
# for the Cloudflare target and are not installed here. The version is pinned in
# package.json, so this needs no lockfile (and pnpm's release-age policy, which rejects
# a same-day wrangler, never applies to the image).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY server ./server
COPY public ./public

EXPOSE 8080
CMD ["node", "server/node.js"]
