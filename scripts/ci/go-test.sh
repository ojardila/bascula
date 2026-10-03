#!/usr/bin/env bash
# Runs the API's Go tests with internal/apitest split across several processes.
#
# Run from services/api. Same tests, same flags as `go test ./...`; only the
# wall clock changes. internal/apitest is ~75% of the Go suite and runs its
# tests one after another against ONE scratch database that its TestMain
# creates. Each process here is a separate TestMain, so each shard gets its
# own scratch database (bascula_test_<random>) on the same Postgres and keeps
# the suite's semantics: one database, tests in source order, nothing
# parallel inside it. The shards take disjoint subsets of the top-level tests
# from `-test.list`, so every test still runs exactly once. The other packages
# run at the same time, as `go test` would.
#
# Placement: four tests are ~70% of the suite (a season of reports, a 12 MB
# upload dribbled past a read timeout, the provisioning poll, the certificate
# gate). scripts/ci/apitest-weights.txt lists them with their seconds; every
# other test counts as 0.25 s, and the heaviest go first to the least loaded
# shard. That file is only a hint for balance: a renamed or new slow test still
# runs, it just lands wherever the count puts it.
#
#   SHARDS        apitest processes (default 4)
#   COVERPROFILE  when set, collect coverage like
#                 `go test -covermode=atomic -coverpkg=./... -coverprofile=...`
#                 and write the merged profile there (counts summed per block)
#
# Locally: TEST_ADMIN_DATABASE_URL=... ../../scripts/ci/go-test.sh
set -euo pipefail

shards="${SHARDS:-4}"
pkg=./internal/apitest
weights="$(cd "$(dirname "$0")" && pwd)/apitest-weights.txt"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cover=()
if [ -n "${COVERPROFILE:-}" ]; then
  cover=(-covermode=atomic -coverpkg=./...)
fi

# One binary for every shard: compiled once, while the other packages build
# and run.
go test -c -o "$tmp/apitest.test" "${cover[@]}" "$pkg"

rest_cover=()
[ -n "${COVERPROFILE:-}" ] && rest_cover=("${cover[@]}" -coverprofile="$tmp/rest.cover")
others=$(go list ./... | grep -v '/internal/apitest$')
# shellcheck disable=SC2086 # one package path per word
go test "${rest_cover[@]}" $others >"$tmp/rest.log" 2>&1 &
rest_pid=$!

# -test.list runs TestMain; without the database URL it only lists.
(cd "$pkg" && env -u TEST_ADMIN_DATABASE_URL "$tmp/apitest.test" -test.list '.*') |
  grep '^Test' >"$tmp/tests.txt" || true
total=$(wc -l <"$tmp/tests.txt")
if [ "$total" -eq 0 ]; then
  echo "no tests listed in $pkg" >&2
  exit 1
fi

# "<shard> <test>" for every test: longest first onto the least loaded shard.
awk -v shards="$shards" '
  FNR == NR { if ($1 !~ /^#/ && NF >= 2) w[$1] = $2; next }
  { n++; name[n] = $1; est[n] = ($1 in w) ? w[$1] : 0.25 }
  END {
    for (i = 1; i <= n; i++) order[i] = i
    for (i = 2; i <= n; i++) {          # insertion sort, heaviest first
      k = order[i]; j = i - 1
      while (j > 0 && est[order[j]] < est[k]) { order[j + 1] = order[j]; j-- }
      order[j + 1] = k
    }
    for (s = 0; s < shards; s++) load[s] = 0
    for (i = 1; i <= n; i++) {
      best = 0
      for (s = 1; s < shards; s++) if (load[s] < load[best]) best = s
      load[best] += est[order[i]]
      print best, name[order[i]]
    }
  }' "$weights" "$tmp/tests.txt" >"$tmp/plan.txt"

pids=()
for ((s = 0; s < shards; s++)); do
  names=$(awk -v s="$s" '$1 == s { print $2 }' "$tmp/plan.txt" | paste -sd'|' -)
  [ -n "$names" ] || continue
  n=$(awk -v s="$s" '$1 == s' "$tmp/plan.txt" | wc -l | tr -d ' ')
  args=(-test.run "^(${names})\$" -test.timeout 10m)
  [ -n "${COVERPROFILE:-}" ] && args+=(-test.coverprofile "$tmp/shard$s.cover")
  # The working directory go test would use, so testdata/ and relative paths
  # resolve the same way.
  (
    start=$SECONDS
    rc=0
    (cd "$pkg" && "$tmp/apitest.test" "${args[@]}") >"$tmp/shard$s.log" 2>&1 || rc=$?
    echo "$((SECONDS - start))" >"$tmp/shard$s.secs"
    exit "$rc"
  ) &
  pids+=("$s:$!:$n")
done

failed=0
for entry in "${pids[@]}"; do
  IFS=: read -r s pid n <<<"$entry"
  if wait "$pid"; then status=ok; else status=FAIL; failed=1; fi
  echo "::group::apitest shard $((s + 1))/${shards}: ${n} tests, ${status} in $(cat "$tmp/shard$s.secs")s"
  cat "$tmp/shard$s.log"
  echo "::endgroup::"
  [ "$status" = ok ] || echo "::error::apitest shard $((s + 1))/${shards} failed (see its group above)"
done

if wait "$rest_pid"; then rest=ok; else rest=FAIL; failed=1; fi
cat "$tmp/rest.log"
[ "$rest" = ok ] || echo "::error::go test (packages other than apitest) failed"

if [ -n "${COVERPROFILE:-}" ]; then
  # Atomic profiles from the same -coverpkg list the same blocks; a block's
  # count is the sum of its counts in every profile.
  {
    echo "mode: atomic"
    cat "$tmp"/*.cover 2>/dev/null | grep -v '^mode:' |
      awk '{ k = $1 " " $2; c[k] += $3 } END { for (k in c) print k, c[k] }' | sort
  } >"$COVERPROFILE"
fi

exit "$failed"
