#!/usr/bin/env bash
# Every source file states its licence on its first line (SPDX), so people and
# SBOM / supply-chain tools read it without knowing the repository layout.
#
#   scripts/check-spdx.sh          list files missing the header, exit 1 if any
#   scripts/check-spdx.sh --fix    add the header where it is missing
#
# Generated files are excluded: a regeneration would drop the line, and
# apps/web/src/api/schema.ts is diffed against openapi.yaml in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

HEADER='// SPDX-License-Identifier: MIT'
EXCLUDE='^apps/web/src/api/schema\.ts$'

files=$(git ls-files 'services/api/*.go' 'apps/web/src/*.ts' 'apps/web/src/*.tsx' 'packages/shared/src/*.ts' \
  | grep -Ev "$EXCLUDE" || true)

missing=()
for f in $files; do
  [ "$(head -n1 "$f")" = "$HEADER" ] || missing+=("$f")
done

if [ "${1:-}" = "--fix" ]; then
  for f in "${missing[@]}"; do
    if [[ "$f" == *.go ]]; then
      printf '%s\n\n' "$HEADER" | cat - "$f" > "$f.spdx" && mv "$f.spdx" "$f"
    else
      printf '%s\n' "$HEADER" | cat - "$f" > "$f.spdx" && mv "$f.spdx" "$f"
    fi
  done
  echo "added the SPDX header to ${#missing[@]} files"
  exit 0
fi

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing "%s" on line 1:\n' "$HEADER" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo "fix: scripts/check-spdx.sh --fix" >&2
  exit 1
fi
echo "SPDX headers: ok"
