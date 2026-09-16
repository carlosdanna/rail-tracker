# Build the client bundle and serve it with nginx, proxying the stream and the
# debug endpoints to the Go server.
#
# The build context is the repository root:
#   docker build -f apps/client/Dockerfile -t rail-tracker-client .
FROM node:24-alpine AS build
WORKDIR /src
RUN corepack enable

# Manifests first so the dependency layer is cached independently of sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/client/package.json apps/client/
RUN pnpm install --frozen-lockfile

COPY apps/client/ apps/client/
RUN pnpm --filter @rail-tracker/client build

FROM nginx:1.29-alpine
COPY --from=build /src/apps/client/dist /usr/share/nginx/html
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
