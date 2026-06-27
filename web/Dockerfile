FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_API_BASE_URL=http://127.0.0.1:8000
ARG VITE_API_BASE=http://127.0.0.1:8000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_API_BASE=$VITE_API_BASE

# Browser-safe, domain-restricted ArcGIS Maps SDK key for the 3D terrain SceneView.
# Build-time only: Vite inlines VITE_* into the static bundle. This is NOT the
# backend ARCGIS_API_KEY and must never be a server-only secret. Empty by default
# so dev/local builds work on Esri's default services without a key.
ARG VITE_ARCGIS_API_KEY=""
ENV VITE_ARCGIS_API_KEY=$VITE_ARCGIS_API_KEY

# The ArcGIS SceneView (3D terrain) bundle is large; give the build extra heap so
# `tsc && vite build` does not OOM in the container's default Node heap.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
