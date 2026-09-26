# syntax=docker/dockerfile:1
# The API, as one static binary in a scratch-sized image.
#
# The migrations are embedded (see migrations/embed.go), so this image can put
# the schema in place and then serve it -- no second image, no init container,
# no SQL files to ship alongside and get out of step with the binary.
FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, so a change to our own code does not re-download the
# module cache on every build.
# The module and build caches are BuildKit cache mounts. In CI they are
# carried between runs (buildkit-cache-dance), so a code change recompiles
# only the packages it touched.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
# CGO off makes it static, so the final image needs no libc at all. No release
# number is stamped in: CI builds this image once per source tree and CD
# promotes the same image to every release that did not touch services/api.
# (The old -X main.version flag pointed at a variable that no longer exists.)
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w" \
      -o /out/api ./cmd/api

FROM alpine:3.21
# ca-certificates only: the binary is static, but TLS to anything outside needs
# the root store. tzdata because settlement periods are farm-local dates and a
# container with no zones resolves America/Bogota to UTC, which moves a week.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -u 10001 bascula
# Uploads outlive the container. The compose file mounts a volume here; without
# it a redeploy loses every photo somebody attached to a weighing.
RUN mkdir -p /srv/uploads && chown bascula:bascula /srv/uploads
USER bascula
COPY --from=build /out/api /usr/local/bin/api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
