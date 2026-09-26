#!/usr/bin/env bash
# Print the content keys the images are built and promoted by:
#
#   api=<key>   everything the API image is built from (services/api)
#   web=<key>   everything the web image is built from (the root npm
#               manifests, apps/web, packages/shared, openapi.yaml)
#
# A key is a hash of git TREE objects, so it depends only on the files, not on
# the commit: a PR head and the squash commit on master that carry the same
# sources get the same key, and a release that did not touch the web gets the
# web key of the previous one. CI pushes images as src-<key>; CD promotes
# src-<key> to the release tag instead of building again.
#
# The release commit (VERSION, manifests/) is outside both keys on purpose.
#
# usage: scripts/ci/source-keys.sh [<git ref>]   (default HEAD)
set -euo pipefail
ref="${1:-HEAD}"

tree() { git rev-parse "${ref}:$1"; }

key() {
  # 20 hex chars of sha256 over the listed trees, prefixed with a schema tag
  # so a change to how the images are built can start fresh keys.
  { echo "k1"; for p in "$@"; do echo "$p $(tree "$p")"; done; } \
    | sha256sum | cut -c1-20
}

echo "api=$(key services/api)"
echo "web=$(key package.json package-lock.json apps/web packages/shared services/api/openapi.yaml)"
