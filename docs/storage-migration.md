# Migrating an existing ERIS deployment from MinIO to SeaweedFS

Fresh installations use SeaweedFS immediately. These steps are for a server with
objects already stored in MinIO. Run them in a maintenance window on the Docker
host. Keep the old MinIO volume and a database backup until the new stack has
been verified and your normal backup/restore rehearsal succeeds.

The transfer copies **current** objects from every source bucket, verifies each
copy by size and SHA-256, and updates `offline_scene_packages` with the new S3
version IDs and ETags. Historical noncurrent object versions and delete markers
are **not** transferred. Preserve the old volume backup if those are needed for
audit or recovery. Existing `minio_bucket` SQL columns keep their names for
schema compatibility; their values are ordinary S3 bucket names.

1. Back up MariaDB and the old MinIO volume using the previous deployment's
   backup procedure. Save the current `.env.proxmox` securely so the old S3
   credentials remain available. Do not run `docker compose down -v`.
2. Check out the SeaweedFS version of ERIS and edit `docker/.env.proxmox`: rename
   `MINIO_ROOT_USER` to `S3_ACCESS_KEY`, `MINIO_ROOT_PASSWORD` to
   `S3_SECRET_KEY`, `MINIO_BUCKET` to `S3_BUCKET`,
   `MINIO_PUBLIC_ENDPOINT` to `S3_PUBLIC_ENDPOINT`, and
   `MINIO_OFFLINE_SCENES_BUCKET` to `S3_OFFLINE_SCENES_BUCKET`. Keep the bucket
   names and credentials the same for the transfer. Stop writers:

   ```bash
   docker stop eris_backend eris_offline_scene_worker
   ```

3. Start a temporary SeaweedFS instance using the **new persistent volume** and
   a separate localhost port. From `docker/`, load the edited environment first:

   ```bash
   set -a; . ./.env.proxmox; set +a
   docker volume create eris_seaweedfs_data
   docker run --rm -d --name eris_seaweedfs_transfer \
     -p 127.0.0.1:19800:8333 -v eris_seaweedfs_data:/data \
     -e AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
     -e AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
     -e S3_BUCKET="${S3_BUCKET:-eris-uploads}" \
     chrislusf/seaweedfs:4.50 mini -dir=/data
   ```

4. From `backend/`, install `requirements.txt` in a Python 3.12 environment and
   export the database and storage settings for the migration process. The old
   MinIO container is still available on port 9800; the new SeaweedFS container
   is on port 19800. Set `SOURCE_S3_ACCESS_KEY` and `SOURCE_S3_SECRET_KEY` from
   the saved old environment, which may differ from the new credentials.

   ```bash
   export DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME="$MARIADB_DATABASE"
   export DB_USER="$MARIADB_USER" DB_PASS="$MARIADB_PASSWORD"
   export JWT_SECRET="$JWT_SECRET"
   export SOURCE_S3_ENDPOINT=http://127.0.0.1:9800
   export SOURCE_S3_ACCESS_KEY='<old MinIO access key>'
   export SOURCE_S3_SECRET_KEY='<old MinIO secret key>'
   export S3_ENDPOINT=http://127.0.0.1:19800
   python -m app.storage_bootstrap
   python -m app.tools.migrate_object_storage
   python -m app.tools.migrate_object_storage --apply
   ```

   The first migration pass copies and verifies but leaves the catalog
   unchanged. The second pass is resumable and commits the new object version
   IDs only after every catalog object verifies. Resolve any reported missing or
   mismatched object before proceeding.

5. Stop the temporary instance, stop the old MinIO container to release port
   9800, and start the new stack from `docker/`:

   ```bash
   docker stop eris_seaweedfs_transfer
   docker stop eris_minio
   docker compose --env-file .env.proxmox \
     -f docker-compose.yml -f docker-compose.proxmox.yml \
     up -d --build --remove-orphans
   ```

6. Check `docker compose ps`, `GET /health`, a photo download, a road inventory
   package download, and an offline terrain package download on a client that
   reaches `S3_PUBLIC_ENDPOINT`. Confirm `seaweedfs-init` exited successfully.
   Run a SeaweedFS volume backup and restore rehearsal before retiring the old
   MinIO volume.

If you roll back, restore the database backup alongside the old stack. The
catalog's version IDs are store-specific; rolling back code alone will leave
offline package identity checks pointed at SeaweedFS versions.
