#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/check-container.sh IMAGE}"
container="$(docker run --detach --publish 127.0.0.1::8080 --env PORT=8080 "$image")"
trap 'docker logs "$container"; docker rm --force "$container" >/dev/null' EXIT
address="$(docker port "$container" 8080/tcp)"

for path in / /api/config; do
  curl --fail --silent --show-error --output /dev/null \
    --connect-timeout 2 --max-time 5 \
    --retry 10 --retry-delay 1 --retry-connrefused --retry-max-time 30 \
    "http://$address$path"
done

echo "Container startup check passed on port 8080."