# Development and legacy Compose services

Use `docker-compose.yml` for local MariaDB and SeaweedFS while running
the API and web development servers from the checkout. Copy `.env.example` to
`.env`, replace the sample passwords, and run `docker compose up -d --build` from
this directory. Both services build from the repository's patched image recipes.
Follow the [local development guide](../../docs/development/getting-started.md)
for the remaining application setup.

The `docker-compose.proxmox.yml` overlay describes the older server stack. The
Caltrans staging and production installation uses the
[rootless Podman deployment](../podman/README.md) and its approved, scanned,
signed images. Deployment image CI covers those five candidate images. It does
not certify a later local rebuild, which may resolve newer OS packages.
Adminer is an optional development utility outside those five runtime images:
`docker compose --profile db-tools up -d adminer`. Its upstream image is not
covered by the deployment image scan or approved for production. Leave the
`db-tools` profile disabled on hosted environments.

All published ports default to loopback, including S3 port 9800. A same-host TLS
proxy can reach those ports directly. A remote proxy needs explicit private
`API_BIND`, `WEB_BIND` and `S3_BIND` addresses with firewall rules limiting access
to the proxy. Presigned file URLs must use the client-accessible S3 origin in
`S3_PUBLIC_ENDPOINT`. Binding the S3 port does not make its buckets public.

The Proxmox template requires explicit environment configuration, database
preparation and administrator setup. It does not provide the Caltrans production
release, signature, secret-mount, rollback and acceptance gates; follow the
[Caltrans Podman runbook](../../docs/operations/caltrans-podman.md) for handover.
