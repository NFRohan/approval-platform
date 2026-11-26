# =====================================================================
# The app as a container (SOW §4.9, §6 hosting): build once, run the
# Node server in scripts/vm-server.mjs. Configuration comes from the
# environment (see docs/DEPLOY.md); nothing secret is baked in.
#
#   docker build -t ams .
#   docker run -p 3000:3000 --env-file .env ams
# =====================================================================
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
# Only what runs: the build, the entry points, the schema for db:apply,
# and production dependencies.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/api ./api
COPY --from=build /app/scripts/vm-server.mjs /app/scripts/db-apply.mjs ./scripts/
COPY --from=build /app/db ./db
COPY --from=build /app/vercel.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "scripts/vm-server.mjs"]
