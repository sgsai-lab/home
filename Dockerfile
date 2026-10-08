FROM node:18-alpine AS builder
WORKDIR /app

# Copy all source files
COPY . .

# Install standard JS and CSS minifiers
RUN npm init -y && npm install -g terser csso-cli

# Minify all JS and CSS files in place (ignoring any backend or unneeded directories)
RUN find . -type f -name '*.js' -not -path './backend/*' -not -path './node_modules/*' -exec terser {} -c -m -o {} \;
RUN find . -type f -name '*.css' -not -path './backend/*' -not -path './node_modules/*' -exec csso -i {} -o {} \;

# Final Stage: Nginx
FROM nginxinc/nginx-unprivileged:stable-alpine

# Copy nginx configuration
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

# Copy individual root files
COPY --from=builder /app/index.html /app/global.css /app/app.js /app/404.html /app/robots.txt /app/sitemap.xml /app/site.webmanifest /usr/share/nginx/html/

# Copy all directories
COPY --from=builder /app/logo/ /usr/share/nginx/html/logo/
COPY --from=builder /app/components/ /usr/share/nginx/html/components/
COPY --from=builder /app/sections/ /usr/share/nginx/html/sections/
COPY --from=builder /app/about/ /usr/share/nginx/html/about/
COPY --from=builder /app/contact/ /usr/share/nginx/html/contact/
COPY --from=builder /app/roadmap/ /usr/share/nginx/html/roadmap/
COPY --from=builder /app/services/ /usr/share/nginx/html/services/
COPY --from=builder /app/vision/ /usr/share/nginx/html/vision/
COPY --from=builder /app/assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
CMD ["/sbin/tini", "-g", "--", "sh", "-c", "node /app/server.mjs & api_pid=$!; trap 'kill \"$api_pid\" 2>/dev/null || true' EXIT; nginx -g 'daemon off;'"]
