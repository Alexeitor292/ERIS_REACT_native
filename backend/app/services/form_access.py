"""Who may open a technical form (its fields, memos, photos, drone surveys, PDF).

Anyone operational can see that an assessment exists, its stage and who has it.
Opening its technical form is narrower until the work is approved:

* **Approved work is open** to every operational user: a form whose assessment
  is APPROVED (or legacy FINALIZED), or a form outside any assessment whose own
  status is APPROVED.
* **Work in progress** opens only to the people on its route: the office chiefs
  of the assessment's office, the branch chief it was handed to, whoever is
  assigned to it (the assignee and any active assignment), and administrators.
* **Always**: the form's owner, and the people it is shared with (the reader
  and editor grants a share gives, ``services/sharing.py``).

Everyone else (a coordinator, another branch, another office) gets 403 with
:data:`IN_PROGRESS_DETAIL` until the assessment is approved or the owner shares
the form. The Maintenance Crew keep their narrow rule: their own forms and
shares only. Guests never reach this; ``public_visibility`` answers for them.

One SQL predicate (:func:`readable_sql`) serves the single-form check and the
lists, so the two cannot drift apart.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..roles import OFFICE_CHIEF, has_role, is_admin, is_operational_user
from . import org_directory

IN_PROGRESS_DETAIL = (
    "This technical form is in progress. Until it is approved, only the people "
    "working on it and those it is shared with can open it."
)

APPROVED_ASSESSMENT_STATES = "('APPROVED','FINALIZED')"


def _linked(s: str) -> str:
    """The assessment ``fa_a`` this form belongs to: as its primary form or an added one."""
    return (
        f"(fa_a.submission_id = {s}.id OR EXISTS ("
        f"SELECT 1 FROM assessment_submissions fa_x WHERE fa_x.assessment_id = fa_a.id AND fa_x.submission_id = {s}.id))"
    )


def readable_sql(db: Session, user: dict, params: dict, *, alias: str = "s") -> str:
    """A SQL condition over ``submissions`` (as ``alias``): the forms ``user`` may open.

    Adds its parameters (``fa_uid``, ``fa_office``) to ``params``.
    """
    if is_admin(user):
        return "1=1"
    s = alias
    params["fa_uid"] = int(user["id"])
    own = (
        f"{s}.created_by_user_id = :fa_uid"
        f" OR EXISTS (SELECT 1 FROM submission_visibility fa_v WHERE fa_v.submission_id = {s}.id AND fa_v.user_id = :fa_uid)"
        f" OR EXISTS (SELECT 1 FROM submission_editors fa_e WHERE fa_e.submission_id = {s}.id AND fa_e.user_id = :fa_uid)"
    )
    if not is_operational_user(user):
        return f"({own})"
    office = org_directory.user_office_code(db, user) if has_role(user, OFFICE_CHIEF) else None
    route = [
        f"fa_a.state IN {APPROVED_ASSESSMENT_STATES}",
        "fa_a.branch_chief_user_id = :fa_uid",
        "fa_a.assigned_engineer_user_id = :fa_uid",
        "EXISTS (SELECT 1 FROM assessment_assignments fa_aa"
        " WHERE fa_aa.assessment_id = fa_a.id AND fa_aa.user_id = :fa_uid AND fa_aa.is_active = 1)",
    ]
    if office:
        params["fa_office"] = office
        route.append("fa_a.office_code = :fa_office")
    return (
        f"({own}"
        f" OR ({s}.status = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM assessments fa_a WHERE {_linked(s)}))"
        f" OR EXISTS (SELECT 1 FROM assessments fa_a WHERE {_linked(s)} AND ({' OR '.join(route)})))"
    )


def can_read(db: Session, user: dict, submission_id: int) -> bool:
    """True when ``user`` may open this technical form (False when there is none)."""
    params: dict = {"fa_sid": int(submission_id)}
    condition = readable_sql(db, user, params)
    row = db.execute(
        text(f"SELECT 1 FROM submissions s WHERE s.id = :fa_sid AND {condition} LIMIT 1"), params
    ).first()
    return row is not None


def can_read_attachment(db: Session, user: dict, attachment_id: int) -> bool:
    """A file that belongs to technical forms opens when one of those forms does.

    A field report's photo (``incident_attachments``) stays readable even when a
    form reuses it, and a file no form holds is not this rule's business.
    """
    params: dict = {"fa_att": int(attachment_id)}
    condition = readable_sql(db, user, params)
    row = db.execute(
        text(
            f"""
            SELECT
              EXISTS (SELECT 1 FROM attachment_links al WHERE al.attachment_id = :fa_att) AS on_forms,
              EXISTS (SELECT 1 FROM incident_attachments ia WHERE ia.attachment_id = :fa_att) AS on_report,
              EXISTS (
                SELECT 1 FROM attachment_links al JOIN submissions s ON s.id = al.submission_id
                 WHERE al.attachment_id = :fa_att AND {condition}
              ) AS readable
            """
        ),
        params,
    ).mappings().first()
    return (not row["on_forms"]) or bool(row["on_report"]) or bool(row["readable"])
