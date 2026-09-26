#!/usr/bin/env bash
# Exit 0 when the image tag is in the registry, 1 when it is not.
#
# Harbor's bascula project answers 412 to a manifest it has not scanned yet
# ("prevent vulnerable images"). That still means the tag exists, so it
# counts as present: promotion waits for the scan (scripts/ci/promote.sh).
#
# usage: scripts/ci/image-exists.sh <registry/project/repo:tag>
set -uo pipefail
out="$(docker buildx imagetools inspect --raw "$1" 2>&1)"
rc=$?
if [ $rc -eq 0 ]; then
  echo "present: $1"
  exit 0
fi
if printf '%s' "$out" | grep -qiE '412|precondition'; then
  echo "present (not scanned yet): $1"
  exit 0
fi
if printf '%s' "$out" | grep -qiE 'not found|manifest unknown|404'; then
  echo "missing: $1"
  exit 1
fi
# Anything else (network, auth) is not a verdict. Say "missing" so the caller
# builds instead of promoting something it could not see.
echo "could not inspect $1, treating as missing: $out" >&2
exit 1
