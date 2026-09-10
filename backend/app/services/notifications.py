"""Delivery for the incident-notification outbox (design §6.3 - §6.6).

``incident_notifications`` is written INSIDE the transaction that changes the
assessment, so the *intent* to notify is atomic with the state change. This
module is the other half: it turns the ``EMAIL`` rows of that outbox into
messages, and it is the only place in the backend that talks to an SMTP relay.

Three properties this module must never lose:

  * **It never raises into a request.** ``flush_after_commit`` is handed to
    FastAPI ``BackgroundTasks`` after ``db.commit()`` returns, so a dead relay
    can only produce a log line and an undelivered row — never a 500 on an
    approval that already happened.
  * **It is bounded.** One after-commit flush sends at most
    ``SMTP_MAX_RECIPIENTS_PER_FLUSH`` messages within
    ``SMTP_FLUSH_BUDGET_S`` seconds. Whatever is left stays in the outbox for
    the sweeper, which is exactly what the outbox is for.
  * **It is disabled by default.** With ``SMTP_HOST`` unset nothing is sent and
    no attempt is recorded; the EMAIL row stays undelivered as the audit record
    that a notice was due. ``MAIL_DEV_DUMP_DIR`` makes the same path testable
    without a mail server by writing each message as an ``.eml`` file.

Nothing here logs a credential or a message body: failures are logged with the
incident id, template code and recipient id only (design §6.6).
"""

from __future__ import annotations

import json
import logging
import smtplib
import time
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings

logger = logging.getLogger("eris.notifications")

# A missing optional template field degrades to an em dash rather than the
# literal "None" or an exception (design §11).
EM_DASH = "—"

# The channel this module delivers. IN_APP rows are the in-app inbox's problem;
# they are never "delivered" by an SMTP relay and are skipped even when their id
# is handed to a flush (design §6.3).
EMAIL_CHANNEL = "EMAIL"

APPROVED_COORDINATOR = "ASSESSMENT_APPROVED_COORDINATOR"

_APPROVED_COORDINATOR_SUBJECT = "ERIS {incident_key} — GeoTech assessment approved ({route_label})"

_APPROVED_COORDINATOR_BODY = """The GeoTech assessment for {incident_key} has been approved.

  Report          {incident_key} — {route_label}
  District        {district}
  GeoTech office  {office_location} ({office_code})
  Approved by     {approved_by_name}, {approved_by_role}
  Approved on     {approved_at}

The assessment is complete. No further GeoTech action is required.
Open it in ERIS: {assessment_url}

This is an automated message from ERIS. Do not reply.
"""

# Every EMAIL row an unknown or future template code produces still has to
# render to *something* deliverable, or one bad row would stall the sweeper.
_GENERIC_SUBJECT = "ERIS {incident_key} — notification"

_GENERIC_BODY = """There is an ERIS notification for {incident_key}.

  Notice          {template_code}
  Report          {incident_key} — {route_label}
  District        {district}

Open it in ERIS: {assessment_url}

This is an automated message from ERIS. Do not reply.
"""


# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------


def email_enabled() -> bool:
    """True when a relay is configured. ``SMTP_HOST`` is the master switch."""
    return bool((settings.SMTP_HOST or "").strip())


def dev_dump_dir() -> Path | None:
    """The ``.eml`` dump directory, used only while email is disabled."""
    raw = (settings.MAIL_DEV_DUMP_DIR or "").strip()
    return Path(raw) if raw else None


def delivery_configured() -> bool:
    """True when a flush could actually do something.

    With neither a relay nor a dump directory the outbox is deliberately inert:
    rows are written, nothing is attempted, ``delivery_attempts`` is NOT
    consumed, and a later ``SMTP_HOST`` still finds them retryable within
    ``SMTP_BACKLOG_MAX_AGE_HOURS`` (design §6.4).
    """
    return email_enabled() or dev_dump_dir() is not None


def web_base_url() -> str:
    return (settings.WEB_BASE_URL or "").rstrip("/")


# ---------------------------------------------------------------------------
# Rendering (design §6.5)
# ---------------------------------------------------------------------------


def _field(payload: dict, key: str) -> str:
    value = payload.get(key)
    if value is None:
        return EM_DASH
    text_value = str(value).strip()
    return text_value or EM_DASH


def render(template_code: str, payload: dict | None, recipient: dict | None = None) -> tuple[str, str]:
    """Render one outbox row into ``(subject, body)``.

    ``payload`` is the JSON written with the notification row, so the message a
    coordinator receives is built from the facts recorded at approval time — not
    from the assessment as it looks whenever the sweeper happens to run. Missing
    optional fields degrade to an em dash.
    """
    data = dict(payload or {})
    fields = {
        "template_code": str(template_code or "").strip() or EM_DASH,
        "incident_key": _field(data, "incident_key"),
        "route_label": _field(data, "route_label"),
        "district": _field(data, "district"),
        "office_code": _field(data, "office_code"),
        "office_location": _field(data, "office_location"),
        "approved_by_name": _field(data, "approved_by_name"),
        "approved_by_role": _field(data, "approved_by_role"),
        "approved_at": _field(data, "approved_at"),
        "assessment_url": _assessment_url(data.get("assessment_id")),
        "recipient_name": _field(dict(recipient or {}), "full_name"),
    }
    if str(template_code) == APPROVED_COORDINATOR:
        return (
            _APPROVED_COORDINATOR_SUBJECT.format(**fields),
            _APPROVED_COORDINATOR_BODY.format(**fields),
        )
    return _GENERIC_SUBJECT.format(**fields), _GENERIC_BODY.format(**fields)


def _assessment_url(assessment_id) -> str:
    base = web_base_url()
    if assessment_id is None:
        return base or EM_DASH
    return f"{base}/assessments/{int(assessment_id)}"


# ---------------------------------------------------------------------------
# Sending (design §6.3, §6.4)
# ---------------------------------------------------------------------------


def _build_message(to: str, subject: str, body: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = formataddr((settings.SMTP_FROM_NAME, settings.SMTP_FROM))
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain="eris")
    message["Auto-Submitted"] = "auto-generated"
    message.set_content(body)
    return message


def _dump_eml(message: EmailMessage, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    # The Message-ID is unique per message and safe as a filename once its
    # angle brackets and '@' are removed.
    stem = str(message["Message-ID"]).strip("<>").replace("@", "_at_").replace("/", "_")
    path = directory / f"{stem}.eml"
    path.write_bytes(bytes(message))
    return path


def send_email(to: str, subject: str, body: str) -> None:
    """Send one message. RAISES on failure; the caller records the attempt.

    With ``SMTP_HOST`` unset and ``MAIL_DEV_DUMP_DIR`` set the message is
    written as an ``.eml`` file instead, which is how CI exercises the whole
    path without a mail server (design §6.4).
    """
    address = (to or "").strip()
    if not address:
        raise ValueError("no recipient address")
    message = _build_message(address, subject, body)

    if not email_enabled():
        directory = dev_dump_dir()
        if directory is None:
            raise RuntimeError("email is disabled (SMTP_HOST unset)")
        _dump_eml(message, directory)
        return

    host = str(settings.SMTP_HOST).strip()
    port = int(settings.SMTP_PORT)
    timeout = int(settings.SMTP_TIMEOUT_S)
    if settings.SMTP_SSL:
        client = smtplib.SMTP_SSL(host, port, timeout=timeout)
    else:
        client = smtplib.SMTP(host, port, timeout=timeout)
    try:
        client.ehlo()
        if settings.SMTP_STARTTLS and not settings.SMTP_SSL:
            client.starttls()
            client.ehlo()
        if settings.SMTP_USER:
            client.login(settings.SMTP_USER, settings.SMTP_PASSWORD or "")
        client.send_message(message, from_addr=settings.SMTP_FROM, to_addrs=[address])
    finally:
        try:
            client.quit()
        except Exception:
            # A relay that drops the connection after DATA has still accepted
            # the message; a failed QUIT must not turn a success into a retry.
            pass


# ---------------------------------------------------------------------------
# The outbox sweeper (design §6.3, §6.6)
# ---------------------------------------------------------------------------


_PENDING_COLUMNS = """
  n.id, n.incident_id, n.recipient_user_id, n.channel, n.template_code,
  n.payload_json, n.delivery_attempts, u.email AS recipient_email,
  u.full_name AS recipient_name
"""


def _pending_rows(db: Session, ids: list[int] | None, limit: int) -> list[dict]:
    """Rows eligible for a delivery attempt right now.

    The back-off is ``min(2 ** attempts, 60)`` minutes since ``last_attempt_at``
    — a column §7.2 added because ``incident_notifications`` has no
    ``updated_at`` to read. A row that has never been attempted has
    ``last_attempt_at IS NULL`` and is eligible immediately.
    """
    params: dict[str, object] = {
        "max_attempts": int(settings.SMTP_MAX_ATTEMPTS),
        "max_age_hours": int(settings.SMTP_BACKLOG_MAX_AGE_HOURS),
        "row_limit": int(limit),
        "channel": EMAIL_CHANNEL,
    }
    where_parts = [
        "n.channel = :channel",
        "n.delivered_at IS NULL",
        "n.delivery_attempts < :max_attempts",
        "n.created_at >= NOW() - INTERVAL :max_age_hours HOUR",
        (
            "(n.last_attempt_at IS NULL"
            " OR n.last_attempt_at <= NOW() - INTERVAL LEAST(POW(2, n.delivery_attempts), 60) MINUTE)"
        ),
    ]
    if ids is not None:
        wanted = sorted({int(x) for x in ids})
        if not wanted:
            return []
        params.update({f"nid_{index}": nid for index, nid in enumerate(wanted)})
        tokens = ", ".join(f":nid_{index}" for index in range(len(wanted)))
        where_parts.append(f"n.id IN ({tokens})")

    rows = db.execute(
        text(
            f"""
            SELECT {_PENDING_COLUMNS}
            FROM incident_notifications n
            JOIN users u ON u.id = n.recipient_user_id
            WHERE {' AND '.join(where_parts)}
            ORDER BY n.id ASC
            LIMIT :row_limit
            """
        ),
        params,
    ).mappings().all()
    return [dict(row) for row in rows]


def _mark_delivered(db: Session, notification_id: int) -> None:
    db.execute(
        text(
            """
            UPDATE incident_notifications
               SET delivered_at = NOW(),
                   last_attempt_at = NOW(),
                   delivery_attempts = delivery_attempts + 1,
                   last_error = NULL
             WHERE id = :nid
            """
        ),
        {"nid": notification_id},
    )
    db.commit()


def _mark_failed(db: Session, notification_id: int, error: str) -> None:
    db.execute(
        text(
            """
            UPDATE incident_notifications
               SET last_attempt_at = NOW(),
                   delivery_attempts = delivery_attempts + 1,
                   last_error = :last_error
             WHERE id = :nid
            """
        ),
        {"nid": notification_id, "last_error": str(error)[:255]},
    )
    db.commit()


def deliver_pending(
    db: Session,
    ids: list[int] | None = None,
    limit: int = 200,
    *,
    budget_s: float | None = None,
) -> dict:
    """Attempt delivery of every eligible EMAIL row, and record each attempt.

    Returns a small summary — ``{"attempted", "delivered", "failed",
    "skipped", "disabled"}`` — for the CLI and the startup log. Each row's
    result is committed in its own short transaction so a failure late in the
    batch cannot un-stamp an earlier success.
    """
    summary = {"attempted": 0, "delivered": 0, "failed": 0, "skipped": 0, "disabled": False}
    if not delivery_configured():
        # Not a failure and not an attempt: the outbox is simply inert until an
        # operator sets SMTP_HOST (design §6.4).
        summary["disabled"] = True
        return summary

    started = time.monotonic()
    for row in _pending_rows(db, ids, limit):
        if budget_s is not None and (time.monotonic() - started) >= float(budget_s):
            # Out of wall-clock budget: the remainder stays in the outbox for
            # the sweeper rather than holding a background worker (design §6.3).
            summary["skipped"] += 1
            continue
        notification_id = int(row["id"])
        address = (row.get("recipient_email") or "").strip()
        if not address:
            _mark_failed(db, notification_id, "no recipient address")
            summary["attempted"] += 1
            summary["failed"] += 1
            _log_failure(row, "no recipient address")
            continue
        try:
            payload = _payload_of(row)
            subject, body = render(
                str(row["template_code"]),
                payload,
                {"email": address, "full_name": row.get("recipient_name")},
            )
            send_email(address, subject, body)
        except Exception as exc:  # noqa: BLE001 - every failure is recorded, never raised
            _mark_failed(db, notification_id, f"{type(exc).__name__}: {exc}")
            summary["attempted"] += 1
            summary["failed"] += 1
            _log_failure(row, f"{type(exc).__name__}: {exc}")
            continue
        _mark_delivered(db, notification_id)
        summary["attempted"] += 1
        summary["delivered"] += 1
    return summary


def _payload_of(row: dict) -> dict:
    raw = row.get("payload_json")
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _log_failure(row: dict, error: str) -> None:
    """Log an attempt failure WITHOUT the message body or any credential."""
    attempts = int(row.get("delivery_attempts") or 0) + 1
    log = logger.warning if attempts >= int(settings.SMTP_MAX_ATTEMPTS) else logger.info
    log(
        "notification delivery failed incident_id=%s template=%s recipient_user_id=%s attempt=%s error=%s",
        row.get("incident_id"),
        row.get("template_code"),
        row.get("recipient_user_id"),
        attempts,
        error,
    )


def flush_after_commit(ids: list[int] | None = None) -> None:
    """Deliver the rows an endpoint just committed. NEVER raises.

    Handed to FastAPI ``BackgroundTasks`` once ``db.commit()`` returns, so the
    reviewer's Approve response is not held by the relay. IN_APP ids may be
    passed in freely — ``deliver_pending`` filters on the EMAIL channel.
    """
    if not delivery_configured():
        return
    wanted = sorted({int(x) for x in (ids or [])})
    if ids is not None and not wanted:
        return
    db = None
    try:
        from ..db import SessionLocal

        db = SessionLocal()
        deliver_pending(
            db,
            ids=wanted if ids is not None else None,
            limit=int(settings.SMTP_MAX_RECIPIENTS_PER_FLUSH),
            budget_s=float(settings.SMTP_FLUSH_BUDGET_S),
        )
    except Exception as exc:  # noqa: BLE001 - a background task must never surface
        logger.warning("notification flush failed: %s: %s", type(exc).__name__, exc)
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass


def sweep_startup() -> dict:
    """The startup half of the sweeper (design §6.3). NEVER raises.

    Bounded by the same per-flush caps so a backlog behind a dead relay cannot
    hold up boot; the rest waits for the next flush or the cron entry
    ``python -m app.tools.flush_email_outbox``.
    """
    summary = {"attempted": 0, "delivered": 0, "failed": 0, "skipped": 0, "disabled": True}
    if not delivery_configured():
        return summary
    db = None
    try:
        from ..db import SessionLocal

        db = SessionLocal()
        summary = deliver_pending(
            db,
            ids=None,
            limit=int(settings.SMTP_MAX_RECIPIENTS_PER_FLUSH),
            budget_s=float(settings.SMTP_FLUSH_BUDGET_S),
        )
        if summary.get("attempted"):
            logger.info("notification outbox sweep at startup: %s", summary)
    except Exception as exc:  # noqa: BLE001 - startup must not fail on the outbox
        logger.warning("notification outbox sweep failed at startup: %s: %s", type(exc).__name__, exc)
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
    return summary
