FROM node:22-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# Final Stage: Nginx
FROM nginxinc/nginx-unprivileged:stable-alpine
USER root
RUN apk add --no-cache nodejs

# The nginx entrypoint renders templates into conf.d, substituting only API_UPSTREAM.
COPY --from=builder /app/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY --from=builder /app/server.mjs /app/server.mjs
COPY --from=builder /app/node_modules/ /app/node_modules/

ENV API_UPSTREAM=http://api:8080 \
    NGINX_ENVSUBST_FILTER=API_UPSTREAM

EXPOSE 8080
USER nginx
CMD ["/bin/sh", "-c", "node /app/server.mjs & exec /docker-entrypoint.sh nginx -g 'daemon off;'"]
