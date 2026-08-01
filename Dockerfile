FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.seed.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run build:seed

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Seed script, runnable from the Render shell: `npm run seed:dist`.
COPY --from=build /app/dist-seed ./dist-seed
# `/app/data` is the Compose volume mount; `/var/data` is the Render disk mount.
# Both are created up front and owned by the non-root `node` user.
RUN mkdir -p /app/data /var/data && chown -R node:node /app /var/data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
