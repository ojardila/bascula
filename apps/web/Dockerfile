# syntax=docker/dockerfile:1
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
COPY packages/shared/package.json packages/shared/
# The npm cache is a BuildKit cache mount: in CI it is carried between runs
# (buildkit-cache-dance), so a changed lockfile downloads only what changed.
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund

COPY packages/shared packages/shared
COPY apps/web apps/web
COPY services/api/openapi.yaml services/api/openapi.yaml

# `build` runs types:check first, which diffs src/api/schema.ts against
# openapi.yaml. A drifted client fails here rather than at runtime, which is
# why openapi.yaml is copied in above.
# The build key (a hash of the web's own sources, from CI). The bundle carries
# it so an old copy on a phone can see it is old. The RELEASE is not baked in:
# CI builds this image once per source key and CD promotes the same image to
# every release that did not touch the web. See src/lib/appVersion.ts.
ARG BUILD=dev
ENV VITE_APP_BUILD=$BUILD
RUN npm run build --workspace apps/web

# nginx-unprivileged listens on 8080 as a non-root user, so the pod needs no
# capabilities and no runAsUser override to satisfy the restricted policy.
FROM nginxinc/nginx-unprivileged:1.29-alpine
USER root
# The stock default.conf goes: ours is rendered from the template below. With
# the stock file present (and owned by nginx), the entrypoint's
# 10-listen-on-ipv6 script runs `apk manifest nginx`, which hangs as a
# non-root user in the cluster; the pod never listened (bascula-dev, v0.2.40).
RUN apk upgrade --no-cache \
 && rm -f /etc/nginx/conf.d/default.conf
USER nginx
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
# A template, not a plain conf: the image's entrypoint renders it with envsubst
# at start (only variables that are set, so nginx's own $uri is left alone).
# That is how /version.json answers with the release from the pod's env.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
ARG BUILD=dev
ENV BASCULA_BUILD=$BUILD \
    BASCULA_VERSION=dev
EXPOSE 8080
