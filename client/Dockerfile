# Build stage
FROM node:25-alpine AS build

WORKDIR /app

# Accept optional build args for Vite environment variables
ARG VITE_API_BASE_URL=""

# npm ci from the committed lockfile → reproducible image (P3-9).
# Full install (incl. devDependencies) — vite/build tooling is needed by `npm run build`.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage — serve with nginx
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
