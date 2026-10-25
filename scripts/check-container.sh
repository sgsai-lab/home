#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/check-container.sh IMAGE}"
container="$(docker run --detach --publish 127.0.0.1::8080 --env PORT=8080 "$image")"
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

echo "Container startup check passed on port 8080."