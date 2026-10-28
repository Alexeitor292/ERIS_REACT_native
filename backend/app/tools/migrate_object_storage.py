"""Copy current S3 objects to SeaweedFS and rebind offline-scene catalog identities.

Run only with API and worker writers stopped. The old store remains untouched.
Historical noncurrent object versions are not copied; retain the old volume backup.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from urllib.parse import urlsplit

from minio import Minio
from sqlalchemy import text

from app.config import settings
from app.db import SessionLocal


def _client(endpoint: str, key: str, secret: str) -> Minio:
    parts = urlsplit(endpoint if "://" in endpoint else f"http://{endpoint}")
    return Minio(parts.netloc, access_key=key, secret_key=secret,
                 secure=parts.scheme == "https", region=settings.S3_REGION)


def _digest(client: Minio, bucket: str, key: str) -> str:
    obj = client.get_object(bucket, key)
    digest = hashlib.sha256()
    try:
        for chunk in obj.stream(1024 * 1024):
            digest.update(chunk)
    finally:
        obj.close()
        obj.release_conn()
    return digest.hexdigest()


def _copy_bucket(source: Minio, target: Minio, bucket: str) -> int:
    if not target.bucket_exists(bucket):
        raise RuntimeError(f"destination bucket {bucket} is missing; run storage_bootstrap first")
    count = 0
    for item in source.list_objects(bucket, recursive=True):
        if item.is_dir:
            continue
        key = item.object_name
        source_info = source.stat_object(bucket, key)
        original_hash = _digest(source, bucket, key)
        try:
            dest = target.stat_object(bucket, key)
        except Exception as exc:
            if getattr(exc, "code", "") not in {"NoSuchKey", "NoSuchObject"}:
                raise
            dest = None
        if (dest is None or dest.size != item.size
                or dest.content_type != source_info.content_type
                or _digest(target, bucket, key) != original_hash):
            stream = source.get_object(bucket, key)
            try:
                target.put_object(bucket, key, stream, item.size,
                                  content_type=source_info.content_type or "application/octet-stream")
            finally:
                stream.close()
                stream.release_conn()
        current = target.stat_object(bucket, key)
        if (current.size != item.size or current.content_type != source_info.content_type
                or _digest(target, bucket, key) != original_hash):
            raise RuntimeError(f"copy verification failed: {bucket}/{key}")
        count += 1
    return count


def _rebind_catalog(target: Minio, apply: bool) -> int:
    with SessionLocal() as db:
        rows = db.execute(text("""
            SELECT id, minio_bucket, object_key, sha256, size_bytes
            FROM offline_scene_packages ORDER BY id
        """)).mappings().all()
        updates = []
        for row in rows:
            bucket, key = row["minio_bucket"], row["object_key"]
            obj = target.stat_object(bucket, key)
            if obj.size != row["size_bytes"] or _digest(target, bucket, key) != row["sha256"].lower():
                raise RuntimeError(f"catalog verification failed: package id {row['id']}")
            updates.append({"id": row["id"], "version": obj.version_id, "etag": obj.etag.strip('"')})
        if apply:
            for values in updates:
                db.execute(text("""
                    UPDATE offline_scene_packages
                    SET object_version_id=:version, object_etag=:etag WHERE id=:id
                """), values)
            db.commit()
        return len(updates)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write new catalog version IDs after verification")
    args = parser.parse_args()
    source = _client(os.environ["SOURCE_S3_ENDPOINT"], os.environ["SOURCE_S3_ACCESS_KEY"],
                     os.environ["SOURCE_S3_SECRET_KEY"])
    target = _client(settings.S3_ENDPOINT, settings.S3_ACCESS_KEY, settings.S3_SECRET_KEY)
    buckets = {item.name for item in source.list_buckets()}
    for bucket in sorted(buckets):
        if not source.bucket_exists(bucket):
            continue
        if not target.bucket_exists(bucket):
            target.make_bucket(bucket)
        print(f"{bucket}: {_copy_bucket(source, target, bucket)} current objects verified")
    print(f"offline scene catalog: {_rebind_catalog(target, args.apply)} rows verified"
          + (" and rebound" if args.apply else " (catalog unchanged; use --apply to rebind)"))


if __name__ == "__main__":
    main()
