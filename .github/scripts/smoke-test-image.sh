#!/usr/bin/env bash
# Smoke-tests a built Selects image on this machine's platform: it starts from an empty volume
# in fake mode as a non-root user, passes its own health check, serves the UI and the PWA files,
# renders a frame with sharp and the bundled fonts, keeps the password gate shut, and stops
# cleanly on SIGTERM.
#
# Usage: smoke-test-image.sh <image>
set -euo pipefail

image=${1:?usage: smoke-test-image.sh <image>}
open=selects-smoke-open
locked=selects-smoke-locked
work=$(mktemp -d)

cleanup() {
  docker rm --force "$open" "$locked" >/dev/null 2>&1 || true
  docker volume rm --force "$open" "$locked" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Writes to stderr, so it is seen when it runs inside $(...) too.
fail() {
  echo "::error::$1" >&2
  if [ -n "${2:-}" ]; then docker logs "$2" >&2 || true; fi
  exit 1
}

check() {
  echo "ok: $1"
}

# Starts the image on a new volume, publishing its port on the given host port.
start() {
  local name=$1 port=$2
  shift 2
  docker volume create "$name" >/dev/null
  docker run --detach --name "$name" --volume "$name:/data" --publish "127.0.0.1:$port:3000" \
    --health-interval 2s "$@" "$image" >/dev/null
}

wait_healthy() {
  local name=$1 status=starting
  for _ in $(seq 1 60); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$name")
    if [ "$status" = healthy ]; then
      check "$name passes its health check"
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then break; fi
    sleep 2
  done
  fail "$name did not become healthy (health: $status)" "$name"
}

# The content type of a path, or fails when it does not answer with the status given.
content_type() {
  local url=$1 want=$2 got
  got=$(curl --silent --output /dev/null --write-out '%{http_code} %{content_type}' "$url")
  [ "${got%% *}" = "$want" ] || fail "$url answered ${got%% *}, not $want"
  echo "${got#* }"
}

# The image itself.
[ "$(docker image inspect --format '{{.Config.User}}' "$image")" = bun ] || fail "the image does not run as bun"
docker image inspect --format '{{json .Config.Env}}' "$image" | grep -q 'INSTAGRAM_API' &&
  fail "the image sets INSTAGRAM_API; it must leave it unset, which is fake mode"
docker image inspect --format '{{json .Config.Volumes}}' "$image" | grep -q '"/data"' || fail "/data is not a volume"
check "the image runs as bun, declares /data and leaves INSTAGRAM_API unset"

# Without a password.
start "$open" 3000
wait_healthy "$open"
base=http://127.0.0.1:3000

[ "$(docker exec "$open" id -u)" != 0 ] || fail "the server runs as root" "$open"
docker logs "$open" 2>&1 | grep -q 'Fake mode' || fail "the server did not start in fake mode" "$open"
docker exec "$open" test -f /data/selects.db || fail "the database is not in the /data volume" "$open"
check "the server runs as a non-root user in fake mode, with its database in /data"

health=$(curl --silent --fail "$base/api/health")
echo "$health" | jq --exit-status '.database.status == "ok"' >/dev/null || fail "health: $health" "$open"
check "/api/health reports the database"

[[ $(content_type "$base/" 200) == text/html* ]] || fail "/ is not HTML"
curl --silent "$base/" | grep -q 'rel="manifest"' || fail "/ is not the built UI"
[[ $(content_type "$base/site.webmanifest" 200) == application/manifest+json* ]] || fail "wrong manifest type"
for icon in favicon.svg favicon-32.png apple-touch-icon.png icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png; do
  [[ $(content_type "$base/$icon" 200) == image/* ]] || fail "/$icon is not an image"
done
check "the UI, the manifest and every icon are served"

docker exec "$open" bun server/src/fixtures.ts /tmp/fixtures >/dev/null
docker cp "$open:/tmp/fixtures/portrait.jpg" "$work/portrait.jpg"
id=$(curl --silent --fail -X POST -H 'content-type: application/octet-stream' \
  --data-binary "@$work/portrait.jpg" "$base/api/uploads?name=portrait.jpg" | jq --raw-output '.select.id')
[ -n "$id" ] && [ "$id" != null ] || fail "the upload was not added" "$open"
curl --silent --fail --output "$work/frame.jpg" --write-out '%{content_type}\n' \
  "$base/api/selects/$id/frame" | grep -q '^image/jpeg' || fail "the frame did not render" "$open"
file "$work/frame.jpg" | grep -q '1440x1800' || fail "the frame is not 1440 x 1800: $(file "$work/frame.jpg")" "$open"
check "a 1440 x 1800 frame renders"

docker stop --time 20 "$open" >/dev/null
code=$(docker inspect --format '{{.State.ExitCode}}' "$open")
[ "$code" = 0 ] || fail "the server exited with $code after SIGTERM, not 0" "$open"
check "SIGTERM stops the server cleanly"

# With the password.
start "$locked" 3001 --env SELECTS_PASSWORD=smoke-test-password
wait_healthy "$locked"
base=http://127.0.0.1:3001

health=$(curl --silent --fail "$base/api/health")
[ "$(echo "$health" | jq --compact-output .)" = '{"status":"ok"}' ] || fail "health without a session: $health" "$locked"
content_type "$base/api/selects" 401 >/dev/null
content_type "$base/" 401 >/dev/null
[[ $(content_type "$base/site.webmanifest" 200) == application/manifest+json* ]] || fail "wrong manifest type"
content_type "$base/icon-512.png" 200 >/dev/null
check "with a password, only the health check, the manifest and the icons answer without a session"

echo "The image passed its smoke test."
