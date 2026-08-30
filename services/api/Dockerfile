# The API, as one static binary in a scratch-sized image.
#
# The migrations are embedded (see migrations/embed.go), so this image can put
# the schema in place and then serve it -- no second image, no init container,
# no SQL files to ship alongside and get out of step with the binary.
FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, so a change to our own code does not re-download the
# module cache on every build.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO off makes it static, so the final image needs no libc at all. The version
# is stamped in for /health to report which commit is actually running -- on a
# one-droplet deployment that is the only way to tell a failed deploy from a
# successful one that changed nothing.
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X main.version=${VERSION}" \
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
