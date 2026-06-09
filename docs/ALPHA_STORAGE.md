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
- Appropriate for internal Caltrans-style networks where clients can reach the MinIO API port directly.
- Do not use on public internet deployments without additional access controls.

> **Important:** MinIO buckets are private by default. Raw object URLs will return `AccessDenied`
> unless the bucket (or prefix) has an anonymous read/download policy set.
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

### Alpha / Proxmox deployment (`docker/.env.proxmox`)

```env
STORAGE_URL_MODE=public
MINIO_PUBLIC_ENDPOINT=http://YOUR_PROXMOX_IP:9800
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

`MINIO_PUBLIC_ENDPOINT` must be a URL that web browsers and mobile clients can reach from their network:

- For Proxmox LAN deployment: `http://<SERVER_LAN_IP>:9800`
- For Docker local dev: `http://127.0.0.1:9800` or `http://localhost:9800`

The MinIO API port (default: `9800` on the Docker host, mapped from container port `9000`) must be reachable from all client devices.

### MinIO Anonymous Read Policy (required for public mode)

MinIO buckets are **private by default**. Direct object URLs (`STORAGE_URL_MODE=public`) will
return `AccessDenied` unless the bucket or prefix has anonymous download access explicitly enabled.

Use the MinIO Client (`mc`) to set the policy after the containers are running:

```bash
# 1. Add an alias pointing to your MinIO instance
mc alias set eris http://<SERVER_IP>:9800 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>

# 2. Grant anonymous download access to the entire bucket
mc anonymous set download eris/eris-uploads
```

This grants `s3:GetObject` to anonymous (unauthenticated) callers, which allows direct object
GET. It does **not** grant `s3:ListBucket`, so clients cannot enumerate the bucket contents —
they can only fetch objects whose full path they already know.

**When is this safe?**
- Only on internal networks (Caltrans LAN, Proxmox private subnet).
- Object keys are UUIDs generated by the backend (`uploads/<uuid>.<ext>`), so they are not guessable.
- Backend still enforces auth before issuing any URL — clients cannot discover keys independently.
- Do not use on internet-facing deployments.

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
      "AllowedOrigins": ["http://YOUR_PROXMOX_IP:5173"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

Apply with:
```bash
mc anonymous set-json cors.json myminio/eris-uploads
```

Or configure via the MinIO Console (port 9801).

In `presigned` mode, MinIO CORS is typically not needed because presigned URLs embed credentials and browsers accept them from any origin.

### Mobile clients

React Native's `fetch` and `Linking.openURL` are not bound by the same-origin policy, so MinIO CORS is not required for mobile clients.

---

## Proxmox Deployment Steps

1. Copy `docker/.env.proxmox.example` to `docker/.env.proxmox`.
2. Set `STORAGE_URL_MODE=public`.
3. Set `MINIO_PUBLIC_ENDPOINT=http://<SERVER_LAN_IP>:9800`.
4. Ensure `MINIO_API_BIND` allows the server LAN IP (or `0.0.0.0`) if needed.
5. Deploy with:
   ```bash
   docker compose --env-file docker/.env.proxmox -f docker/docker-compose.proxmox.yml up -d
   ```
6. **Set MinIO anonymous download policy** (required for public mode):
   ```bash
   mc alias set eris http://<SERVER_LAN_IP>:9800 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
   mc anonymous set download eris/eris-uploads
   # Verify:
   mc anonymous get eris/eris-uploads
   # Expected: download
   ```
7. (Optional) Configure MinIO CORS if browser direct GET requires it (see section above).
8. Verify: open the ERIS web app, navigate to a submission with an attachment, and confirm the
   photo loads directly from MinIO (check browser DevTools Network tab — requests should go to
   port 9800, not 8000). If you see `AccessDenied`, re-check step 6.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| MinIO port not reachable from clients | Set `MINIO_API_BIND=0.0.0.0` in docker env; verify firewall allows port 9800 from client subnets |
| Browser CORS error in public mode | Configure MinIO CORS to allow web app origin |
| Stale URLs (presigned mode) | Default 900-second expiry. For long-lived links, re-call download-url. |
| MinIO returns AccessDenied in public mode | Anonymous download policy must be set on the bucket (`mc anonymous set download eris/<bucket>`). Private-by-default is MinIO's baseline. |
| Unintended public read after enabling anonymous policy | Policy grants GET only, not LIST. Object keys are UUIDs — not guessable. Acceptable on internal-only alpha networks; remove policy before any public exposure. |

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
