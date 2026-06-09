# ERIS Proxmox Deployment (No Local Dev Impact)

This guide adds a server deployment path without changing your local dev flow.

## What was added

- `docker/docker-compose.proxmox.yml`
- `docker/.env.proxmox.example`
- `backend/Dockerfile`
- `backend/.dockerignore`
- `web/Dockerfile`
- `web/nginx.conf`
- `web/.dockerignore`

Your existing local files remain valid:

- local infra: `docker/docker-compose.yml`
- local backend: `backend/.env`
- local web: `web/.env`
- local mobile: `mobile/.env`

## 1) Create Ubuntu LXC on Proxmox

Recommended:

- Ubuntu 22.04 or 24.04
- 2 vCPU, 4 GB RAM minimum
- 30+ GB disk
- Bridge networking with static IP

Install Docker + Compose plugin inside the LXC.

## 2) Copy repository to container

Example:

```bash
git clone <your-repo-url> /opt/ERIS_REACT_native
cd /opt/ERIS_REACT_native/docker
```

## 3) Create Proxmox env file

```bash
cp .env.proxmox.example .env.proxmox
```

Edit `.env.proxmox` values:

- secure DB/MinIO/JWT secrets
- set `VITE_API_BASE_URL` to Proxmox host/IP
- set `CORS_ORIGINS` to web URL
- optional `MINIO_PUBLIC_ENDPOINT` if exposing MinIO externally

Important:

- Proxmox deployment uses `.env.proxmox` as the single env source.
- You do not need a separate `docker/.env` on the server.

## 4) Build and start stack

From `docker/` directory:

```bash
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml up -d --build
```

This will run:

- MariaDB
- MinIO
- FastAPI backend (`:8000`)
- Vite-built web via Nginx (`:5173`)

`adminer` is disabled by default in Proxmox (profile: `devtools`).

To run Adminer temporarily:

```bash
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml --profile devtools up -d adminer
```

## 5) Stamp the Alembic baseline (one-time, first deploy after adding Alembic)

After the first successful backend startup, stamp the database to the migration baseline.
This records the current schema version without altering the database.

```bash
# Always backup before touching schema
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec mariadb sh -c 'mysqldump -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  > /opt/backups/eris_pre_alembic_$(date +%Y%m%d_%H%M).sql

# Stamp the baseline
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic stamp 0001_baseline

# Verify
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic current
# Expected: 0001_baseline (head)
```

Skip this step on subsequent deploys — it is needed only once per database.

## 6) Verify

```bash
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml ps
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:5173/healthz
```

If the backend fails to start with a `RuntimeError` about Alembic head, the database
is not stamped. Follow step 5 above before the backend will accept connections.

From your browser:

- `http://<proxmox-ip>:5173`

## 7) Mobile access on same network

Set `EXPO_PUBLIC_API_URL=http://<proxmox-ip>:8000` in `mobile/.env` when testing against server.

## 8) Update / redeploy

```bash
cd /opt/ERIS_REACT_native
git pull
cd docker
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml up -d --build
```

After a redeploy that includes new Alembic migrations, apply them:

```bash
# Backup first
docker compose --env-file .env.proxmox -f docker-compose.yml \
  exec mariadb sh -c 'mysqldump -u "$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' \
  > /opt/backups/eris_pre_upgrade_$(date +%Y%m%d_%H%M).sql

# Apply migrations
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic upgrade head

# Verify
docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml \
  exec backend alembic current
```

## Notes

- This deployment path does not alter local development commands or env files.
- Vite env is compile-time, so changing `VITE_API_BASE_URL` requires rebuilding `web`.
- For internet-facing deployment, see the Public Internet Deployment section below.

---

## Public Internet Deployment (Cloudflare + Caddy Reverse Proxy)

This section documents the working public showcase architecture for
`eris.camposlabs.org` / `api.camposlabs.org` / `files.camposlabs.org`.
It is **separate from** the future Caltrans internal deployment, which will use private
DNS and an internal proxy on the Caltrans network — no Cloudflare required for that scenario.

### Architecture Overview

```
                   [Internet]
                       |
             [Cloudflare DNS + proxy]
             eris / api / files .camposlabs.org  → 104.220.27.58
                       |
             [UniFi / WAN router]
             WAN :80  → 192.168.20.20:80
             WAN :443 → 192.168.20.20:443
                       |
        ┌──────────────────────────────┐
        │  VM 102 — eris-proxy         │  192.168.20.20
        │  Caddy (public ingress)       │
        │  Cloudflare Origin Cert here  │
        └──────────────────────────────┘
                       |  (internal LAN)
        ┌──────────────────────────────┐
        │  VM 101 — ERIS-server         │  192.168.20.75
        │  Docker: backend :8000        │
        │          web :5173            │
        │          minio :9800          │
        │          mariadb :3306        │
        └──────────────────────────────┘
```

**Key rule:** Public internet traffic enters only through eris-proxy (VM 102).
ERIS-server (VM 101) is **not** forwarded directly from WAN and should not be.

### Two Deployment Scenarios

| | Public showcase (camposlabs) | Caltrans internal (future) |
|---|---|---|
| DNS | Cloudflare, proxied | Internal DNS or `/etc/hosts` |
| TLS | Cloudflare Full (strict) + Caddy + Origin Cert | Internal CA or self-signed |
| Reverse proxy | eris-proxy VM (Caddy) | Internal Nginx/Caddy |
| MinIO access | Via `files.camposlabs.org` (Caddy → 9800) | Direct LAN IP:9800 |
| STORAGE_URL_MODE | `public` | `public` or `presigned` |

---

### Step A — Cloudflare

1. Add DNS records (proxied, orange cloud):
   ```
   A  eris   → 104.220.27.58   (proxied)
   A  api    → 104.220.27.58   (proxied)
   A  files  → 104.220.27.58   (proxied)
   ```
2. Set SSL/TLS mode to **Full (strict)** in the Cloudflare dashboard.
   - "Flexible" or "Full" will not enforce certificate validation and should not be used.
3. Generate a **Cloudflare Origin Certificate** (15-year, wildcard `*.camposlabs.org` or per-hostname).
   Download the `.pem` and `.key` files — you will install these on eris-proxy only.

---

### Step B — UniFi Port Forwarding

Forward WAN ports 80 and 443 to eris-proxy (VM 102 at `192.168.20.20`):

| WAN port | → | LAN destination |
|----------|---|-----------------|
| TCP 80   | → | 192.168.20.20:80  |
| TCP 443  | → | 192.168.20.20:443 |

Do **not** forward port 8000, 5173, or 9800 from WAN — those are ERIS-server internal ports.

---

### Step C — eris-proxy (VM 102): Caddy Setup

Create VM 102 as a lightweight Ubuntu LXC. Install Caddy.

Copy the Cloudflare Origin Certificate files to eris-proxy, e.g.:
```
/etc/caddy/certs/origin.pem
/etc/caddy/certs/origin.key
```

Create `/etc/caddy/Caddyfile`:

```caddyfile
(origin_cert) {
  tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
}

eris.camposlabs.org {
  import origin_cert
  reverse_proxy 192.168.20.75:5173
}

api.camposlabs.org {
  import origin_cert
  reverse_proxy 192.168.20.75:8000
}

files.camposlabs.org {
  import origin_cert
  reverse_proxy 192.168.20.75:9800
}
```

Start Caddy:
```bash
systemctl enable --now caddy
caddy validate --config /etc/caddy/Caddyfile  # check syntax first
systemctl reload caddy
```

Caddy on eris-proxy handles TLS termination. It does **not** need auto-HTTPS (the origin cert
replaces that). Traffic from Caddy to ERIS-server travels over the internal LAN (HTTP).

---

### Step D — ERIS-server (VM 101): env configuration

In `docker/.env.proxmox`:
```env
STORAGE_URL_MODE=public
MINIO_PUBLIC_ENDPOINT=https://files.camposlabs.org

VITE_API_BASE_URL=https://api.camposlabs.org
VITE_API_BASE=https://api.camposlabs.org
CORS_ORIGINS=https://eris.camposlabs.org

MINIO_API_BIND=127.0.0.1
MINIO_CONSOLE_BIND=127.0.0.1
```

> Setting `MINIO_API_BIND=127.0.0.1` and `MINIO_CONSOLE_BIND=127.0.0.1` ensures MinIO
> listens only on localhost on ERIS-server. Port 9800 is never directly reachable from WAN —
> all access goes via eris-proxy → Caddy → 192.168.20.75:9800 (LAN).

Deploy and build (run from `/opt/ERIS_REACT_native/docker` on ERIS-server):
```bash
docker compose --env-file .env.proxmox \
  -f docker-compose.yml \
  -f docker-compose.proxmox.yml \
  up -d --build
```

---

### Step E — MinIO Anonymous Download Policy

Run on ERIS-server (where MinIO port 9800 is reachable at localhost):
```bash
mc alias set eris http://localhost:9800 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
mc anonymous set download eris/eris-uploads
mc anonymous get eris/eris-uploads   # expected: download
```

For why this is required and the security rationale, see
[docs/ALPHA_STORAGE.md — MinIO Anonymous Read Policy](./ALPHA_STORAGE.md).

---

### Step F — MinIO CORS

Browsers loading `https://eris.camposlabs.org` will fetch files from `https://files.camposlabs.org`.
This is cross-origin, so MinIO CORS must allow the web origin.

Save this as `cors.json` on ERIS-server:
```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://eris.camposlabs.org"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Apply:
```bash
mc cors set eris/eris-uploads cors.json
```

---

### Verification

From a browser or external device:
```
https://eris.camposlabs.org        → web app loads
https://api.camposlabs.org/health  → {"ok": true}
```

Log in, open a submission with an attached photo, and check the browser Network tab:
- The photo request should go to `https://files.camposlabs.org/eris-uploads/uploads/...`
- It should return `200 OK`, **not** `AccessDenied`
- The request should **not** go to `api.camposlabs.org` (that would mean the `/content` fallback is active)

If the Cloudflare SSL handshake fails, confirm:
- Caddy is presenting the Cloudflare Origin Certificate (not a self-signed cert)
- Cloudflare SSL mode is **Full (strict)**, not Flexible
