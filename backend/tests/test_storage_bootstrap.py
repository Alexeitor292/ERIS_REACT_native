"""Fail-closed bucket posture required before API and worker start."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.storage_bootstrap import bootstrap


def _client(*, uploads_exists=True, scenes_exists=True, policy=None, versioning="Enabled"):
    client = MagicMock()
    client.bucket_exists.side_effect = lambda name: uploads_exists if name == "uploads" else scenes_exists
    if policy is None:
        from minio.error import S3Error
        client.get_bucket_policy.side_effect = S3Error(
            "missing", "NoSuchBucketPolicy", "", "", "", None
        )
    else:
        client.get_bucket_policy.return_value = policy
    client.get_bucket_versioning.return_value = SimpleNamespace(status=versioning)
    return client


def test_new_scene_bucket_is_created_with_object_lock():
    client = _client(scenes_exists=False)
    bootstrap(client, "uploads", "scenes")
    client.make_bucket.assert_called_once_with("scenes", object_lock=True)
    client.get_object_lock_config.assert_called_once_with("scenes")


def test_public_allow_policy_blocks_startup():
    client = _client(policy='{"Statement":[{"Effect":"Allow","Principal":"*"}]}')
    with pytest.raises(RuntimeError, match="anonymous allow"):
        bootstrap(client, "uploads", "scenes")


def test_unversioned_scene_bucket_blocks_startup():
    client = _client(versioning="Suspended")
    with pytest.raises(RuntimeError, match="versioning enabled"):
        bootstrap(client, "uploads", "scenes")
