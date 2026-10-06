FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html 404.html styles.css pages.css script.js products.js favicon.svg favicon.ico favicon-192.png favicon-512.png apple-touch-icon.png og-image.jpg site.webmanifest robots.txt sitemap.xml ./
COPY vision/ vision/
COPY products/ products/
COPY roadmap/ roadmap/
COPY about/ about/
COPY contact/ contact/
COPY privacy/ privacy/
COPY terms/ terms/
COPY logo/ logo/
COPY scripts/build.mjs scripts/build.mjs
COPY partials/ partials/
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine
USER root
RUN apk add --no-cache nodejs npm tini && mkdir -p /app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./server.mjs
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
CMD ["/sbin/tini", "-g", "--", "sh", "-c", "node /app/server.mjs & api_pid=$!; trap 'kill \"$api_pid\" 2>/dev/null || true' EXIT; nginx -g 'daemon off;'"]
