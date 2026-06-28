"""Pure state-machine tests for offline_scene_jobs (no DB)."""

from __future__ import annotations

from app.services import offline_scene_jobs as jobs


def test_state_sets_are_consistent():
    assert "QUEUED" in jobs.ACTIVE_STATES
    assert jobs.TERMINAL_STATES == {"READY", "FAILED", "CANCELLED"}
    assert "FETCHING_USGS_3DEP" in jobs.RUNNING_STATES
    # terminal and active are disjoint
    assert jobs.ACTIVE_STATES.isdisjoint(jobs.TERMINAL_STATES)


def test_can_cancel_and_retry():
    assert jobs.can_cancel("QUEUED") is True
    assert jobs.can_cancel("BUILDING_TERRAIN") is True
    assert jobs.can_cancel("READY") is False
    assert jobs.can_cancel("FAILED") is False
    assert jobs.can_retry("FAILED") is True
    assert jobs.can_retry("READY") is False
    assert jobs.can_retry("QUEUED") is False


def test_progress_increases_through_pipeline():
    seq = ["QUEUED", "FETCHING_USGS_3DEP", "BUILDING_TERRAIN", "PACKAGING", "VERIFYING", "UPLOADING", "REGISTERING", "READY"]
    vals = [jobs.progress_for(s) for s in seq]
    assert vals == sorted(vals)
    assert jobs.progress_for("READY") == 100
    assert jobs.progress_for("FAILED") == 0
