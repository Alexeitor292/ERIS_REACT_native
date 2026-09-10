"""Flush the incident-notification EMAIL outbox (design §6.3).

The cron half of the sweeper. The other two halves are the after-commit flush
handed to FastAPI ``BackgroundTasks`` by ``POST /assessments/{id}/review`` and
the startup sweep in ``app.main``'s lifespan; all three call the same
``services.notifications.deliver_pending``, so there is one delivery rule and
one back-off, not three.

    python -m app.tools.flush_email_outbox
    python -m app.tools.flush_email_outbox --limit 500 --json

Contract:
  * Reads and writes only ``incident_notifications`` (``delivered_at``,
    ``delivery_attempts``, ``last_error``, ``last_attempt_at``).
  * Never prints a message body, a recipient address or an SMTP credential.
  * With ``SMTP_HOST`` unset it reports ``disabled`` and touches nothing — the
    EMAIL rows stay as the audit record that a notice was due (design §6.4).
  * Exit code 0 whenever the sweep ran, including a sweep that delivered
    nothing; 1 only when the sweep itself could not run (no database, say), so a
    cron entry alerts on a broken sweeper rather than on a quiet mailbox.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from ..config import settings
from ..db import SessionLocal
from ..services import notifications as notifications_svc


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m app.tools.flush_email_outbox",
        description="Deliver pending EMAIL rows from the incident-notification outbox.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=200,
        help="Maximum rows to attempt in this run (default: 200).",
    )
    parser.add_argument(
        "--budget-seconds",
        type=float,
        default=None,
        help="Wall-clock budget for this run; the remainder stays in the outbox. "
        "Default: no budget, because a cron run is not holding a request.",
    )
    parser.add_argument("--json", action="store_true", help="Print the summary as JSON.")
    parser.add_argument("--verbose", action="store_true", help="Log each attempt at INFO level.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    db = None
    try:
        db = SessionLocal()
        summary = notifications_svc.deliver_pending(
            db,
            ids=None,
            limit=max(1, int(args.limit)),
            budget_s=args.budget_seconds,
        )
    except Exception as exc:  # noqa: BLE001 - the sweeper failing to RUN is the alert
        print(f"outbox flush failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass

    if args.json:
        print(json.dumps(summary, sort_keys=True))
    elif summary.get("disabled"):
        print(
            "email is disabled (SMTP_HOST unset and MAIL_DEV_DUMP_DIR unset): "
            "nothing attempted, EMAIL rows left undelivered"
        )
    else:
        print(
            "attempted={attempted} delivered={delivered} failed={failed} "
            "deferred={skipped} max_attempts={max_attempts} backlog_max_age_hours={max_age}".format(
                max_attempts=settings.SMTP_MAX_ATTEMPTS,
                max_age=settings.SMTP_BACKLOG_MAX_AGE_HOURS,
                **summary,
            )
        )
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
