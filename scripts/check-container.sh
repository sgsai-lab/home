#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/check-container.sh IMAGE}"
# FIRESTORE_DISABLED runs the API on its in-memory store: the smoke test has no cloud credentials.
container="$(docker run --detach --publish 127.0.0.1::8080 --env PORT=8080 --env FIRESTORE_DISABLED=true \
  --env ANDROID_CERT_SHA256=AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99 \
  --env APPLE_TEAM_ID=ABCDE12345 "$image")"
trap 'docker logs "$container"; docker rm --force "$container" >/dev/null' EXIT
address="$(docker port "$container" 8080/tcp)"

# Wait for container and backend processes to be ready
ready=false
for _ in $(seq 1 30); do
  if curl --fail --silent --output /dev/null "http://$address/" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" != "true" ]; then
  echo "Container failed to respond on http://$address/" >&2
  exit 1
fi

for path in / /api/config /assets/js/app.js /assets/js/auth.js /assets/css/global.css /components/header/header.html; do
  curl --fail --silent --show-error --output /dev/null \
    --connect-timeout 2 --max-time 5 \
    --retry 10 --retry-delay 1 --retry-connrefused --retry-all-errors --retry-max-time 30 \
    "http://$address$path"
done

base="http://$address"
expect_status() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "$base$2")"
  if [ "$status" != "$1" ]; then
    echo "Expected $1 from $2, got $status" >&2
    exit 1
  fi
}

expect_status 200 /api/readyz
expect_status 404 /go/does-not-exist
expect_status 404 /api/v1/does-not-exist
expect_status 401 /api/v1/users/me
expect_status 200 /sw.js
expect_status 200 /workspace/
expect_status 200 /.well-known/assetlinks.json
expect_status 200 /.well-known/apple-app-site-association
expect_status 404 /.well-known/other

for file in assetlinks.json apple-app-site-association; do
  type="$(curl --silent --output /dev/null --write-out '%{content_type}' --max-time 5 "$base/.well-known/$file")"
  case "$type" in
    application/json*) ;;
    *) echo "/.well-known/$file served as '$type', expected application/json" >&2; exit 1 ;;
  esac
done

# Security headers must reach every response type, not only the homepage.
for path in / /about/ /login/ /assets/js/app.js /.well-known/assetlinks.json; do
  headers="$(curl --silent --head --max-time 5 "$base$path")"
  for header in "content-security-policy:.*storage.googleapis.com" "x-frame-options: DENY" "x-content-type-options: nosniff"; do
    if ! grep -qi "^$header" <<<"$headers"; then
      echo "$path is missing the '$header' header" >&2
      exit 1
    fi
  done
done

echo "Container startup check passed on port 8080."