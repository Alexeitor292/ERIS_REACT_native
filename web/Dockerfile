FROM node:22-alpine AS prepared

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM prepared AS build

ARG VITE_API_BASE_URL=/api
ARG VITE_API_BASE=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_API_BASE=$VITE_API_BASE
ARG VITE_ENTRA_ENABLED=false
ARG VITE_LOCAL_LOGIN_ENABLED=true
ENV VITE_ENTRA_ENABLED=$VITE_ENTRA_ENABLED
ENV VITE_LOCAL_LOGIN_ENABLED=$VITE_LOCAL_LOGIN_ENABLED
ARG VITE_GUIDED_DEMO_ENABLED=false
ENV VITE_GUIDED_DEMO_ENABLED=$VITE_GUIDED_DEMO_ENABLED

# Browser-safe, domain-restricted ArcGIS Maps SDK key for the 3D terrain SceneView.
# Build-time only: Vite inlines VITE_* into the static bundle. This is NOT the
# backend ARCGIS_API_KEY and must never be a server-only secret. Empty by default
# so dev/local builds work on Esri's default services without a key.
ARG VITE_ARCGIS_API_KEY=""
ENV VITE_ARCGIS_API_KEY=$VITE_ARCGIS_API_KEY

# Optional public settings (see web/.env.example). Empty means: no Caltrans
# highways overlay, the default public postmile layer, Street View in a new tab.
ARG VITE_CALTRANS_HIGHWAYS_URL=""
ARG VITE_CALTRANS_POSTMILE_LAYER_URL=""
ARG VITE_GOOGLE_MAPS_EMBED_KEY=""
ENV VITE_CALTRANS_HIGHWAYS_URL=$VITE_CALTRANS_HIGHWAYS_URL
ENV VITE_CALTRANS_POSTMILE_LAYER_URL=$VITE_CALTRANS_POSTMILE_LAYER_URL
ENV VITE_GOOGLE_MAPS_EMBED_KEY=$VITE_GOOGLE_MAPS_EMBED_KEY

# The ArcGIS SceneView (3D terrain) bundle is large; give the build extra heap so
# `tsc && vite build` does not OOM in the container's default Node heap.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

FROM nginx:1.30.6-alpine@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a
# Keep configuration/static assets owned by root. Only nginx's runtime state
# directories are writable by UID101; the listener uses an unprivileged port.
RUN apk upgrade --no-cache \
    && test "$(id -u nginx)" = 101 \
    && test "$(id -g nginx)" = 101 \
    && sed -ri '/^[[:space:]]*user[[:space:]]/d; s@^[[:space:]]*pid[[:space:]]+[^;]+;@pid /tmp/nginx.pid;@' /etc/nginx/nginx.conf \
    && grep -q '^pid /tmp/nginx.pid;' /etc/nginx/nginx.conf \
    && mkdir -p /var/cache/nginx /var/log/nginx \
    && chown -R 101:101 /var/cache/nginx \
    && chown 101:101 /var/log/nginx

COPY nginx.conf /etc/nginx/conf.d/default.conf
# Compose uses a separate API network namespace. Shared-pod builds explicitly
# select loopback; restrict this internal build input to the supported modes.
ARG ERIS_API_UPSTREAM=backend:8000
RUN case "$ERIS_API_UPSTREAM" in backend:8000|127.0.0.1:8000) ;; *) exit 2 ;; esac \
    && sed -i "s|http://127.0.0.1:8000/|http://$ERIS_API_UPSTREAM/|" /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

USER 101:101
EXPOSE 8080
