# The web app, built once and served as static files.
#
# Built from the REPOSITORY ROOT, not from this directory: the web imports
# @bascula/shared through the npm workspace, so the build needs the root
# package-lock.json and packages/ as well.
#
#   docker build -f apps/web/Dockerfile .
#
# No VITE_API_BASE_URL is passed in on purpose. It defaults to "" (see
# apps/web/src/api/mode.ts), which makes the browser fetch /v1 and /health
# relative to wherever the page was served from — and the HTTPRoute puts the
# API on those two prefixes of the same hostname. That is the "same origin"
# half of the choice docs/decisiones.md left open, and it is what lets the API
# keep having no CORS middleware at all.
FROM node:24-alpine AS build
WORKDIR /src

# The lockfile and the manifests first, so editing a component does not
# re-resolve the whole tree on every build.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
RUN npm ci

COPY packages/shared packages/shared
COPY apps/web apps/web
COPY services/api/openapi.yaml services/api/openapi.yaml

# `build` runs types:check first, which diffs src/api/schema.ts against
# openapi.yaml. A drifted client fails here rather than at runtime, which is
# why openapi.yaml is copied in above.
RUN npm run build --workspace apps/web

# nginx-unprivileged listens on 8080 as a non-root user, so the pod needs no
# capabilities and no runAsUser override to satisfy the restricted policy.
FROM nginxinc/nginx-unprivileged:1.29-alpine
USER root
RUN apk upgrade --no-cache
USER nginx
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
