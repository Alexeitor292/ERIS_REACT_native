# ERIS Alpha: Direct Storage URL Architecture

## Overview

For the alpha deployment, ERIS routes file access (attachment previews, photo thumbnails, PDF downloads) directly from the client to MinIO/S3-compatible object storage — bypassing the backend FastAPI proxy.

The backend remains the system of record for authentication, authorization, metadata, and URL generation. Clients use the backend to obtain download URLs, then fetch content directly from storage.

---

## Storage URL Modes

Set `STORAGE_URL_MODE` in the backend environment:

| Mode | Value | Description |
|------|-------|-------------|
| Presigned (default) | `presigned` | Backend returns expiring MinIO presigned GET URLs. Works in any deployment. |
| Public (alpha) | `public` | Backend returns deterministic direct object URLs. Requires `MINIO_PUBLIC_ENDPOINT` and client network access to MinIO. |

### `presigned` mode (default)

- Backend calls MinIO's presigned URL API and returns a time-limited signed URL.
- `MINIO_PUBLIC_ENDPOINT` (optional): rewrites the presigned URL's host/port so clients can reach MinIO externally (e.g., when MinIO's internal Docker address differs from what browsers/mobile see).
- `expires_seconds` is returned with the URL (default: 900 seconds).
- Safe for any deployment.

### `public` mode (alpha/internal)

- Backend returns `{MINIO_PUBLIC_ENDPOINT}/{bucket}/{object_key}` — no signing, no expiry.
- `MINIO_PUBLIC_ENDPOINT` is **required** (startup/URL generation fails clearly if missing).
- `expires_seconds` is returned as `null`.
- `MINIO_PUBLIC_ENDPOINT` can be:
  - An internal LAN address (`http://192.168.20.75:9800`) — for Caltrans-style private deployments.
  - A public hostname behind a reverse proxy (`https://files.camposlabs.org`) — for the public
    showcase deployment where Caddy/Cloudflare fronts MinIO over TLS.

> **Important:** MinIO buckets are private by default. Raw object URLs will return `AccessDenied`
> unless the bucket has an anonymous read/download policy set.
> You must explicitly grant anonymous download access before public mode works.
> See [MinIO Anonymous Read Policy](#minio-anonymous-read-policy-required-for-public-mode) below.
> `presigned` mode does **not** require anonymous bucket access — presigned URLs carry
> embedded credentials and work against private buckets.

---

## Environment Variables

### Backend (`backend/.env` or passed via Docker)

```env
# presigned (default) or public
STORAGE_URL_MODE=presigned

# Client-reachable MinIO API URL.
# Required in public mode; optional in presigned mode (rewrites host in signed URL).
MINIO_PUBLIC_ENDPOINT=http://<ERIS_SERVER_IP_OR_INTERNAL_DNS>:9800
```

### Public showcase deployment — camposlabs (Cloudflare + eris-proxy)

MinIO is fronted by Caddy on VM 102 (eris-proxy) at `files.camposlabs.org`. Clients never
connect to the MinIO port directly; TLS is terminated by Cloudflare + Caddy.

```env
STORAGE_URL_MODE=public
MINIO_PUBLIC_ENDPOINT=https://files.camposlabs.org
CORS_ORIGINS=https://eris.camposlabs.org
VITE_API_BASE_URL=https://api.camposlabs.org
```

See [docs/PROXMOX_DEPLOYMENT.md — Public Internet Deployment](./PROXMOX_DEPLOYMENT.md) for the
full two-VM Caddy setup and Cloudflare configuration.

### Caltrans internal deployment (future, LAN-only)

MinIO is exposed only on the private LAN; clients reach it directly by IP/port.

```env
STORAGE_URL_MODE=public
MINIO_PUBLIC_ENDPOINT=http://<ERIS_SERVER_LAN_IP>:9800
CORS_ORIGINS=http://<ERIS_SERVER_LAN_IP>:5173
VITE_API_BASE_URL=http://<ERIS_SERVER_LAN_IP>:8000
```

---

## API Endpoints

### `GET /attachments/{id}/download-url`

Returns a storage URL for an attachment. Requires authentication and submission read access.

**Response:**
```json
{
  "attachment_id": 42,
  "storage_key": "uploads/abc123.jpg",
  "download_url": "http://10.0.0.1:9800/eris-uploads/uploads/abc123.jpg",
  "expires_seconds": null
}
```

- `expires_seconds` is an integer in presigned mode, `null` in public mode.
- Used by both mobile and web clients for photo preview, attachment download, and PDF open.

### `GET /photos/{id}/download`

Alias for `/attachments/{id}/download-url`. Returns identical response shape.

### `POST /submissions/{id}/gisa/pdf` and `GET /submissions/{id}/gisa/pdf`

Generate or retrieve the GISA PDF for a submission. The `download_url` field in the response uses the same URL mode as above.

### Deprecated / Fallback Endpoints

The following endpoints remain available for backward-compatibility during the alpha transition but should not be used in new client code:

- `GET /attachments/{id}/content` — proxies bytes through FastAPI
- `GET /photos/{id}/content` — alias for the above

These will be removed after clients have fully migrated to the download-url flow.

---

## Client Flows

### Mobile (Expo / React Native)

- **Photo preview:** `hydrateAttachmentUrls()` calls `GET /attachments/{id}/download-url` for each attachment and stores the returned `download_url`. Falls back to `/content` proxy on error.
- **PDF open:** `generateGisaPdf()` and `openLatestGisaPdf()` use the `download_url` from the GISA PDF response directly.
- **Upload:** uses `POST /submissions/{id}/attachments` multipart form data via
  `uploadSubmissionAttachment()` in `mobile/src/api/submissions.ts`. Upload flow is unchanged
  by this diff. Note: `mobile/src/api/uploads.ts` exports `presign()`, `complete()`, and
  `putToPresignedUrl()` (intended for a future presigned PUT flow), but these functions are
  not imported anywhere in the app and are currently dead code.

### Web (Vite / React)

- **Attachment download:** `openDownloadUrl()` calls `GET /attachments/{id}/download-url` and opens the returned `download_url` in a new tab.

---

## MinIO Deployment Notes for Alpha

### Network reachability

`MINIO_PUBLIC_ENDPOINT` must be a URL that web browsers and mobile clients can reach. Two patterns:

**Direct (Caltrans internal / LAN-only):**
- `http://<SERVER_LAN_IP>:9800` — clients hit the MinIO API port directly.
- Requires port 9800 to be open to client subnets. Set `MINIO_API_BIND=0.0.0.0` if needed.

**Reverse-proxy (public showcase / Cloudflare):**
- `https://files.camposlabs.org` — Cloudflare → Caddy on eris-proxy → MinIO on port 9800.
- The MinIO port does **not** need to be directly reachable from clients; only port 443 on
  the eris-proxy host needs to be reachable.
- TLS is terminated by Cloudflare (Full strict) and Caddy holds the Cloudflare Origin Certificate.
- See [PROXMOX_DEPLOYMENT.md](./PROXMOX_DEPLOYMENT.md) for Caddy configuration.

**Local dev:**
- `http://127.0.0.1:9800` or `http://localhost:9800`

### MinIO Anonymous Read Policy (required for public mode)

MinIO buckets are **private by default**. Direct object URLs (`STORAGE_URL_MODE=public`) will
return `AccessDenied` unless the bucket or prefix has anonymous download access explicitly enabled.

Use the MinIO Client (`mc`) to set the policy after the containers are running.
Run these commands **on the ERIS-server host** (VM 101), where MinIO is accessible
at `http://localhost:9800` without going through the proxy:

```bash
# 1. Add an alias pointing directly to the MinIO API (internal address, not the proxy)
mc alias set eris http://localhost:9800 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
# Or from another LAN host: mc alias set eris http://192.168.20.75:9800 ...

# 2. Grant anonymous download access to the entire bucket
mc anonymous set download eris/eris-uploads
```

This grants `s3:GetObject` to anonymous (unauthenticated) callers, which allows direct object
GET. It does **not** grant `s3:ListBucket`, so clients cannot enumerate the bucket contents —
they can only fetch objects whose full path they already know.

**When is this acceptable?**
- Object keys are UUIDs generated by the backend (`uploads/<uuid>.<ext>`), so they are not
  guessable without a prior authorized API call.
- The backend enforces auth before issuing any URL — unauthenticated clients cannot discover keys.
- **Internal networks (Caltrans LAN, Proxmox private subnet):** directly acceptable; only
  on-network clients can reach MinIO at all.
- **Public hostname behind reverse proxy (camposlabs):** acceptable for the alpha showcase because
  the anonymous policy is GET-only (not LIST), keys are UUIDs, and auth guards URL issuance.
  This is an alpha posture — for a production Caltrans deployment, switch to `presigned` mode
  so no anonymous bucket access is required.

**Presigned mode does not require this step.** Presigned URLs carry embedded credentials
and work against private buckets without any anonymous policy.

To verify the policy is active:
```bash
mc anonymous get eris/eris-uploads
# Expected output: download
```

To revoke (return to private):
```bash
mc anonymous set none eris/eris-uploads
```

### MinIO CORS (browser direct GET)

In `public` mode, browsers fetch files directly from MinIO. If the web app origin differs from the MinIO endpoint, MinIO CORS must be configured to allow the web app's origin.

**Example CORS config via MinIO Client (`mc`):**

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

Save as `cors.json`, then apply from the ERIS-server host:
```bash
mc cors set eris/eris-uploads cors.json
# Or for older mc versions:
mc anonymous set-json cors.json eris/eris-uploads
```

For a Caltrans LAN deployment replace the origin with `http://<SERVER_LAN_IP>:5173`.

Or configure via the MinIO Console (`http://192.168.20.75:9801` internally, not exposed externally).

In `presigned` mode, MinIO CORS is typically not needed because presigned URLs embed credentials and browsers accept them from any origin.

### Mobile clients

React Native's `fetch` and `Linking.openURL` are not bound by the same-origin policy, so MinIO CORS is not required for mobile clients.

---

## Proxmox Deployment Steps

These steps cover the storage-specific configuration on **ERIS-server (VM 101)**.
For the full two-VM public internet architecture (Cloudflare + eris-proxy), see
[docs/PROXMOX_DEPLOYMENT.md — Public Internet Deployment](./PROXMOX_DEPLOYMENT.md).

### Public showcase (camposlabs)

1. On ERIS-server, copy `docker/.env.proxmox.example` to `docker/.env.proxmox`.
2. Set the following in `.env.proxmox`:
   ```env
   STORAGE_URL_MODE=public
   MINIO_PUBLIC_ENDPOINT=https://files.camposlabs.org
   CORS_ORIGINS=https://eris.camposlabs.org
   VITE_API_BASE_URL=https://api.camposlabs.org
   ```
3. Deploy the ERIS stack on ERIS-server:
   ```bash
   cd /opt/ERIS_REACT_native/docker
   docker compose --env-file .env.proxmox -f docker-compose.yml -f docker-compose.proxmox.yml up -d --build
   ```
4. **Set MinIO anonymous download policy** (run on ERIS-server after containers are up):
   ```bash
   mc alias set eris http://localhost:9800 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
   mc anonymous set download eris/eris-uploads
   mc anonymous get eris/eris-uploads   # expected: download
   ```
5. Configure MinIO CORS for the web origin (run on ERIS-server):
   ```bash
   # Save cors.json first (see MinIO CORS section above for content)
   mc cors set eris/eris-uploads cors.json
   ```
6. Set up eris-proxy (VM 102) with Caddy pointing `files.camposlabs.org` → `192.168.20.75:9800`.
   See [PROXMOX_DEPLOYMENT.md](./PROXMOX_DEPLOYMENT.md) for the Caddy config.
7. Verify: open `https://eris.camposlabs.org`, navigate to a submission with an attachment, and
   confirm the photo loads from `https://files.camposlabs.org/...` (check browser Network tab).
   If you see `AccessDenied`, re-check step 4.

### Caltrans internal (future LAN deployment)

Same as above with these differences in `.env.proxmox`:
```env
MINIO_PUBLIC_ENDPOINT=http://<ERIS_SERVER_LAN_IP>:9800
CORS_ORIGINS=http://<ERIS_SERVER_LAN_IP>:5173
VITE_API_BASE_URL=http://<ERIS_SERVER_LAN_IP>:8000
```
No eris-proxy or Cloudflare required. Ensure MinIO port 9800 is reachable from client subnets.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| MinIO port not reachable from clients | Set `MINIO_API_BIND=0.0.0.0` in docker env; verify firewall allows port 9800 from client subnets |
| Browser CORS error in public mode | Configure MinIO CORS to allow web app origin |
| Stale URLs (presigned mode) | Default 900-second expiry. For long-lived links, re-call download-url. |
| MinIO returns AccessDenied in public mode | Anonymous download policy must be set on the bucket (`mc anonymous set download eris/<bucket>`). Private-by-default is MinIO's baseline. |
| Anonymous policy exposes objects to anyone with a URL | Policy grants GET only (not LIST). Keys are UUIDs. Auth gates URL issuance. Acceptable for alpha — switch to `presigned` mode for production Caltrans deployment. |
| Public traffic hitting ERIS-server directly | All inbound traffic must enter via eris-proxy (VM 102). ERIS-server (VM 101) should not be port-forwarded directly from WAN. |

---

## Recommended Commit Message

```
Use direct storage URLs for alpha file access

- Add STORAGE_URL_MODE config (presigned/public)
- Add object_public_url() and object_access_url() to storage.py
- Update /attachments/{id}/download-url, GISA PDF endpoints to use object_access_url()
- Mark /attachments/{id}/content and /photos/{id}/content as fallback/deprecated
- Mobile: use download_url from API for photo hydration and PDF open
- Web: fetch download_url from API instead of constructing /content URL
- Add STORAGE_URL_MODE to env examples; document alpha/Proxmox config
- Add unit tests for storage URL helpers
```
