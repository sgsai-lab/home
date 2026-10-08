FROM node:22-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

# Final Stage: Nginx
FROM nginxinc/nginx-unprivileged:stable-alpine
USER root
RUN apk add --no-cache nodejs

# Copy nginx configuration
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY --from=builder /app/server.mjs /app/server.mjs
COPY --from=builder /app/node_modules/ /app/node_modules/

EXPOSE 8080
USER nginx
CMD ["/bin/sh", "-c", "node /app/server.mjs & api_pid=$!; trap 'kill \"$api_pid\" 2>/dev/null || true' EXIT; nginx -g 'daemon off;'" ]
