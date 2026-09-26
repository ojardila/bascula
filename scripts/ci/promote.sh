#!/usr/bin/env bash
# Give an image that is already in the registry one more tag, without pulling
# or rebuilding it: a registry-side copy of the manifest.
#
# --prefer-index=false keeps it a carbon copy (same digest). Wrapping it in a
# new index would be a new artifact that Harbor has not scanned, and the
# project answers 412 to unscanned artifacts, so Argo could not pull it.
#
# The source can itself be unscanned for a minute right after a push (the
# build-in-CD fallback). Retry until Harbor has scanned it.
#
# usage: scripts/ci/promote.sh <src ref> <dst ref>
set -uo pipefail
src="$1"
dst="$2"
for i in $(seq 1 40); do
  if out="$(docker buildx imagetools create --prefer-index=false -t "$dst" "$src" 2>&1)"; then
    echo "promoted ${src} -> ${dst}"
    exit 0
  fi
  echo "promote ${src} -> ${dst} failed (${i}): ${out}" | tail -n 3
  sleep 6
done
echo "could not promote ${src} to ${dst}" >&2
exit 1
