"""Provision and verify the SeaweedFS S3 buckets before API/worker startup."""

from __future__ import annotations

import json
import os
import time

from minio import Minio
from minio.error import S3Error
from urllib3.exceptions import HTTPError


def _private(client: Minio, bucket: str) -> None:
    try:
        policy = json.loads(client.get_bucket_policy(bucket))
    except S3Error as exc:
        if exc.code in {"NoSuchBucketPolicy", "NoSuchPolicy"}:
            return
        raise
    for statement in policy.get("Statement", []):
        if statement.get("Effect") != "Allow":
            continue
        principal = statement.get("Principal")
        if principal == "*" or (isinstance(principal, dict) and "*" in str(principal.get("AWS", ""))):
            raise RuntimeError(f"bucket {bucket} has an anonymous allow policy")


def bootstrap(client: Minio, uploads: str, scenes: str) -> None:
    if not client.bucket_exists(uploads):
        client.make_bucket(uploads)
    _private(client, uploads)

    if not client.bucket_exists(scenes):
        client.make_bucket(scenes, object_lock=True)
    _private(client, scenes)
    versioning = client.get_bucket_versioning(scenes)
    if versioning.status != "Enabled":
        raise RuntimeError(f"bucket {scenes} must have versioning enabled")
    # Object Lock enabled at bucket creation is separate from a retention policy.
    # Existing ERIS deployments do not configure default retention.
    client.get_object_lock_config(scenes)


def main() -> None:
    endpoint = os.environ["S3_ENDPOINT"].removeprefix("http://").removeprefix("https://")
    client = Minio(
        endpoint,
        access_key=os.environ["S3_ACCESS_KEY"],
        secret_key=os.environ["S3_SECRET_KEY"],
        secure=os.environ["S3_ENDPOINT"].startswith("https://"),
        region=os.environ.get("S3_REGION", "us-east-1"),
    )
    uploads = os.environ.get("S3_BUCKET", "eris-uploads")
    scenes = os.environ.get("S3_OFFLINE_SCENES_BUCKET", "eris-offline-scenes")
    for attempt in range(60):
        try:
            bootstrap(client, uploads, scenes)
            print(f"S3 buckets ready: {uploads}, {scenes}")
            return
        except (S3Error, HTTPError, OSError) as exc:
            if attempt == 59:
                raise RuntimeError(f"S3 bootstrap failed: {exc}") from exc
            time.sleep(2)


if __name__ == "__main__":
    main()
