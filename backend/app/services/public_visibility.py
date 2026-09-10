"""What a read-only Viewer may see: the approved record, and nothing else.

``CALTRANS_VIEWER`` is a THIRD CATEGORY, not an operational role (design §4.1).
``roles.OPERATIONAL_ROLES`` is a flat, STATE-BLIND switch — ``can_view_submission``
returns True for every operational user and ``list_submissions`` hands them DRAFT
rows — so "approved only" cannot be expressed by adding a name to a role list.
It is expressed here instead, and applied per handler.

TWO MECHANISMS, deliberately different, and both are needed:

**(a) The positive predicate — this module.** For the endpoints a viewer MAY
reach. ``scope_public`` narrows a list query, ``ensure_public_assessment`` /
``ensure_public_incident`` guard a detail read, and
``viewer_can_read_public_submission`` answers the submission question.

**(b) The explicit refusal — ``deps.deny_public_only``.** For everything else. A
census of every route under ``backend/app`` found 39 of 137 carrying no
``require_roles`` at all, eleven of them writes, so "any endpoint nobody
remembers to touch simply 403s the viewer" was false (design §4.5). Every
authenticated-only route that is not in :data:`VIEWER_READABLE_ROUTES` carries
``deny_public_only``, and ``tests/test_route_guards.py`` walks the live route
table to keep that true.

THREE RULES the callers depend on, stated once here so they cannot drift.

1. **Public means APPROVED or FINALIZED, statewide, whole record.** That pair is
   already the repo's meaning of "official" (``incident_classification._CONFIRMED_STATES``);
   ``FINALIZED`` is legacy-only because ``trg_assessment_no_new_finalize`` refuses
   new entries. Anything in flight — new, COORDINATOR_REVIEW,
   PENDING_OFFICE_DELEGATION, PENDING_ENGINEER_ASSIGNMENT, DRAFT, SUBMITTED,
   REVISION_REQUESTED — is not public.

2. **404, never 403, for a non-public record.** A viewer must not be able to
   enumerate in-flight work by probing ids: a 403 would confirm the record
   exists. Refusals that are about the ROLE rather than the record (writes,
   queues, personnel data) still answer 403 — there is nothing to enumerate.

3. **``is_public_only``, never ``is_public_viewer``.** A chief who is also
   granted Viewer keeps full chief access; the narrowing fires only when Viewer
   is the account's only role. ``can_view_submission`` and photo-map's separate
   ``_can_view_submission`` are NOT widened — they have fourteen call sites
   between them, three of which must stay closed to a viewer (a write behind a
   read gate, and two personnel-data reads), so this module carries its own
   predicate (design §4.4).
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..roles import is_public_only, is_public_viewer  # noqa: F401  (re-exported)

# The two states that make a record public. FINALIZED is legacy history: no new
# assessment can enter it, but the rows that are there are approved work.
PUBLIC_ASSESSMENT_STATES: tuple[str, ...] = ("APPROVED", "FINALIZED")

# The same pair as a SQL literal, for the predicates below. Written out rather
# than bound as parameters because these fragments are concatenated into queries
# that already carry positional parameter names, and an inlined constant cannot
# collide with one.
_STATES_SQL = "('APPROVED','FINALIZED')"

_NOT_FOUND = "Not found"


def assessment_is_public(assessment: dict | None) -> bool:
    """True when this assessment row is part of the public record."""
    if not assessment:
        return False
    return str(assessment.get("state") or "").strip().upper() in PUBLIC_ASSESSMENT_STATES


# ---------------------------------------------------------------------------
# List queries
# ---------------------------------------------------------------------------


def scope_public(user: dict, where: list[str], params: dict, *, alias: str = "a") -> None:
    """Narrow an ``assessments`` query to the public record, for a viewer only.

    A no-op for every other account, so it is safe to call unconditionally
    beside the existing filters.
    """
    if is_public_only(user):
        where.append(f"{alias}.state IN {_STATES_SQL}")


def public_incident_sql(alias: str = "i") -> str:
    """The row predicate for "this incident's record is public".

    An incident is public when it carries an approved assessment. Incidents
    closed at triage with no assessment — ``NO_ASSESSMENT_REQUIRED``,
    ``DUPLICATE_OR_LINKED`` — are not, unless the deployment flips
    ``PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT`` (design §4.2, open question 4).
    """
    approved = (
        f"EXISTS (SELECT 1 FROM assessments pa"
        f" WHERE pa.incident_id = {alias}.id AND pa.state IN {_STATES_SQL})"
    )
    if not settings.PUBLIC_INCLUDES_CLOSED_WITHOUT_ASSESSMENT:
        return approved
    closed_at_triage = (
        f"({alias}.triage_disposition IN ('NO_ASSESSMENT_REQUIRED','DUPLICATE_OR_LINKED')"
        f" AND NOT EXISTS (SELECT 1 FROM assessments pa2 WHERE pa2.incident_id = {alias}.id))"
    )
    return f"({approved} OR {closed_at_triage})"


def scope_public_incidents(user: dict, where: list[str], params: dict, *, alias: str = "i") -> None:
    """Narrow an ``incidents`` query to the public record, for a viewer only."""
    if is_public_only(user):
        where.append(public_incident_sql(alias))


# ---------------------------------------------------------------------------
# Detail reads
# ---------------------------------------------------------------------------


def ensure_public_assessment(user: dict, assessment: dict | None) -> None:
    """404 unless this assessment is public. A no-op for every other account."""
    if not is_public_only(user):
        return
    if not assessment_is_public(assessment):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)


def incident_is_public(db: Session, incident_id: int) -> bool:
    """Does this incident carry an approved assessment (or a public closure)?"""
    where_sql = public_incident_sql("i")
    row = db.execute(
        text(f"SELECT 1 FROM incidents i WHERE i.id = :iid AND {where_sql} LIMIT 1"),
        {"iid": int(incident_id)},
    ).first()
    return bool(row)


def ensure_public_incident(db: Session, user: dict, incident_id: int) -> None:
    """404 unless this incident's record is public. A no-op for every other account."""
    if not is_public_only(user):
        return
    if not incident_is_public(db, incident_id):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)


def filter_public_incident_ids(db: Session, incident_ids: list[int]) -> list[int]:
    """The subset of these incident ids whose record is public, order preserved."""
    ordered = [int(i) for i in incident_ids]
    if not ordered:
        return []
    params = {f"iid_{index}": incident_id for index, incident_id in enumerate(ordered)}
    placeholders = ", ".join(f":iid_{index}" for index in range(len(ordered)))
    where_sql = public_incident_sql("i")
    rows = db.execute(
        text(f"SELECT i.id FROM incidents i WHERE i.id IN ({placeholders}) AND {where_sql}"),
        params,
    ).scalars().all()
    public = {int(x) for x in rows}
    return [incident_id for incident_id in ordered if incident_id in public]


# ---------------------------------------------------------------------------
# Technical forms (submissions), photos and attachments
# ---------------------------------------------------------------------------


def viewer_can_read_public_submission(db: Session, user: dict, submission_id: int) -> bool:
    """Submission -> its assessment -> is that assessment public?

    The SEPARATE predicate promised by design §4.4, called only by the read
    endpoints §4.5 allows. It deliberately does NOT reuse
    ``main.can_view_submission``: that helper has eleven call sites and
    photo-map's twin has three more, and widening either would grant all fourteen
    at once — including ``POST /submissions/{id}/gisa/pdf`` (a write behind a
    read gate) and ``/shared-with`` + ``/permissions`` (personnel data, not the
    record).

    The submission -> assessment join matches ``linked_assessment_for_submission``
    (``main.py``): the assessment's own ``submission_id`` plus every
    ``assessment_submissions`` sibling, so a supplemental form attached to an
    approved assessment reads exactly like the primary one.
    """
    if not is_public_only(user):
        return False
    row = db.execute(
        text(
            f"""
            SELECT 1
            FROM assessments a
            WHERE a.state IN {_STATES_SQL}
              AND (
                a.submission_id = :sid
                OR EXISTS (
                  SELECT 1 FROM assessment_submissions s
                  WHERE s.assessment_id = a.id AND s.submission_id = :sid
                )
              )
            LIMIT 1
            """
        ),
        {"sid": int(submission_id)},
    ).first()
    return bool(row)


def viewer_can_read_public_attachment(db: Session, user: dict, attachment_id: int) -> bool:
    """Attachment -> attachment_links -> submission -> assessment -> state.

    Photos and attachments are part of "the entire approved record" (owner
    decision 4), and the file endpoints carry no assessment context of their own,
    so the walk happens here. Open question 5: if the answer becomes "the
    rendered record only", this function is the single place that changes.
    """
    if not is_public_only(user):
        return False
    row = db.execute(
        text(
            f"""
            SELECT 1
            FROM attachment_links al
            JOIN assessments a
              ON a.submission_id = al.submission_id
              OR EXISTS (
                SELECT 1 FROM assessment_submissions s
                WHERE s.assessment_id = a.id AND s.submission_id = al.submission_id
              )
            WHERE al.attachment_id = :aid
              AND a.state IN {_STATES_SQL}
            LIMIT 1
            """
        ),
        {"aid": int(attachment_id)},
    ).first()
    return bool(row)


def ensure_public_submission(db: Session, user: dict, submission_id: int) -> None:
    """404 unless this technical form belongs to a public assessment.

    For a non-viewer this is a no-op — the caller's own permission check still
    runs and still answers 403, which is right: an operational user probing an
    id is not enumerating anything they cannot already list.
    """
    if not is_public_only(user):
        return
    if not viewer_can_read_public_submission(db, user, submission_id):
        raise HTTPException(status_code=404, detail=_NOT_FOUND)


# ---------------------------------------------------------------------------
# The census allow list
# ---------------------------------------------------------------------------

# Every route here is authenticated-only ON PURPOSE: it is readable by a viewer
# and the "approved only" half is enforced INSIDE the handler by the predicate
# named beside it. Every OTHER authenticated-only route carries
# ``deps.deny_public_only``; every remaining route carries ``require_roles``.
# ``tests/test_route_guards.py`` walks the live route table and fails the build
# on anything that is in none of the three groups, which is what turns design
# §4.5's claim into a check (design §12).
#
# Keyed by (METHOD, path template) exactly as FastAPI reports it.
VIEWER_READABLE_ROUTES: dict[tuple[str, str], str] = {
    ("GET", "/auth/me"): "own identity only",
    ("GET", "/gisa/lookups"): "static label dictionary, no record data",
    ("GET", "/org/offices"): "office and branch names for labels only, no personnel",
    ("GET", "/incidents/{incident_id}/workflow-tree"): "workflow_tree._ensure_workflow_tree_access",
    ("GET", "/submissions"): "scope narrowed to public assessments in the handler",
    ("GET", "/submissions/{submission_id}"): "viewer_can_read_public_submission",
    ("GET", "/submissions/{submission_id}/geometry"): "viewer_can_read_public_submission",
    ("GET", "/submissions/{submission_id}/gisa/pdf"): "viewer_can_read_public_submission",
    ("GET", "/submissions/{submission_id}/photo-map"): "viewer_can_read_public_submission",
    (
        "GET",
        "/submissions/{submission_id}/photo-map/photos/{attachment_id}/corrected-export",
    ): "viewer_can_read_public_submission",
    ("GET", "/attachments/{attachment_id}/download-url"): "viewer_can_read_public_attachment",
    ("GET", "/attachments/{attachment_id}/content"): "viewer_can_read_public_attachment",
    ("GET", "/photos/{photo_id}/download"): "viewer_can_read_public_attachment",
    ("GET", "/photos/{photo_id}/content"): "viewer_can_read_public_attachment",
    # Unauthenticated by design, and not viewer-specific.
    ("POST", "/auth/login"): "the login itself",
    ("GET", "/health"): "liveness probe, no data",
}
