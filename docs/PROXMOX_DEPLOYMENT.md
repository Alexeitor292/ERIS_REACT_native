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
- For internet-facing deployment, place a reverse proxy (Nginx/Traefik/Caddy) in front and add TLS.
