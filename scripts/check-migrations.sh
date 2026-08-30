#!/usr/bin/env bash
#
# A migration whose version is not strictly above every version already on
# master is a hard boot failure at every deployed site -- not a test failure,
# not a conflict git will show you. store/migrate.go calls goose.UpContext
# without WithAllowMissing, so goose refuses to run at all:
#
#   goose up: error: found 1 missing migrations before current version 21:
#            version 20: 00020_week_prices_are_money.sql
#
# The suite cannot catch this, because it migrates a fresh scratch database on
# every run, where ordering is never violated. Only a database that already
# carries history says no -- which means production says it first.
#
# Two branches independently picked 00020 while master sat at 00021 with 00020
# unused. The gap looks free and is not. This is the check that says so.
set -euo pipefail

DIR="services/api/migrations"
BASE="${1:-origin/master}"

fail() { echo "migrations: $*" >&2; exit 1; }

version_of() { basename "$1" | sed -E 's/^0*([0-9]+)_.*/\1/'; }

# 1. No two migrations may claim the same version, on any tree.
dupes=$(for f in "$DIR"/*.sql; do version_of "$f"; done | sort -n | uniq -d)
if [ -n "$dupes" ]; then
  fail "two migrations claim the same version: $dupes"
fi

# 2. Nothing added since the base may sit at or below the base's high-water
#    mark -- including a version that fills an unused gap.
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "migrations: no $BASE to compare against; checked uniqueness only"
  exit 0
fi

high=0
while read -r f; do
  [ -n "$f" ] || continue
  v=$(version_of "$f")
  [ "$v" -gt "$high" ] && high=$v
done < <(git ls-tree --name-only "$BASE" "$DIR/" | grep '\.sql$' || true)

if [ "$high" -eq 0 ]; then
  echo "migrations: $BASE carries none; checked uniqueness only"
  exit 0
fi

added=$(git diff --name-only --diff-filter=A "$BASE"...HEAD -- "$DIR" | grep '\.sql$' || true)
[ -n "$added" ] || { echo "migrations: none added; $(ls "$DIR"/*.sql | wc -l | tr -d ' ') on file, high-water $high"; exit 0; }

status=0
while read -r f; do
  [ -n "$f" ] || continue
  v=$(version_of "$f")
  if [ "$v" -le "$high" ]; then
    echo "migrations: $(basename "$f") is version $v, but $BASE already reached $high." >&2
    echo "            goose will refuse to migrate any database already at $high." >&2
    echo "            Renumber it above $high. A gap below $high is not free." >&2
    status=1
  fi
done <<< "$added"
[ "$status" -eq 0 ] || exit 1

echo "migrations: ok -- added above the $high high-water mark"
