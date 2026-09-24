"""Who has a say when a technical form is shared (the team's rule, 2026-09-23).

A share gives the person both viewing and editing. Whether it needs approval
depends on where the two people sit in the office trees:

* **Branch chiefs gate their branch.** Anything going into or out of a branch
  needs its chief's approval, and a share across branches needs every chief
  involved. The one exception is a share that stays inside one branch: it goes
  through at once, and the branch chief is told and may stop it.
* **Office chiefs are told, and may stop it**, when the share leaves their
  office or involves one of their Senior Specialists (who report to them
  directly). They never have to approve.

So: same branch — immediate, branch chief notified. Two branches of one office
— both branch chiefs approve. Two offices — both branch chiefs approve, both
office chiefs notified. Senior Specialist to Senior Specialist — immediate,
their office chief(s) notified. Staff to a Senior Specialist — the staff
member's branch chief approves, the office chief(s) notified.

"From" is the form's owner; "to" is the person it is shared with. Someone
placed nowhere (a coordinator, an unplaced account) brings no rule of their
own, but a share out of a branch to them still needs that branch's chief.
"""
from __future__ import annotations

from dataclasses import dataclass

APPROVAL = "APPROVAL"  # must approve before the share takes effect
NOTICE = "NOTICE"  # told; may stop it, need not act
BRANCH = "BRANCH"
OFFICE = "OFFICE"

_BRANCH_POSITIONS = {"BRANCH_CHIEF", "STAFF"}


@dataclass(frozen=True)
class Place:
    position: str | None = None
    office_id: int | None = None
    branch_id: int | None = None

    @property
    def branch(self) -> int | None:
        return self.branch_id if self.position in _BRANCH_POSITIONS and self.branch_id else None

    @property
    def office(self) -> int | None:
        return self.office_id if self.position else None


@dataclass(frozen=True)
class Review:
    unit_type: str
    unit_id: int
    kind: str


def reviews_for(owner: Place, recipient: Place) -> list[Review]:
    """The branch and office chiefs who approve or are told, in that order."""
    found: dict[tuple[str, int], str] = {}

    def add(unit_type: str, unit_id: int, kind: str) -> None:
        key = (unit_type, unit_id)
        if found.get(key) != APPROVAL:
            found[key] = kind

    a, b = owner.branch, recipient.branch
    if a and a == b:
        add(BRANCH, a, NOTICE)
    else:
        for branch in (a, b):
            if branch:
                add(BRANCH, branch, APPROVAL)
    for person in (owner, recipient):
        if person.position == "SENIOR_SPECIALIST" and person.office:
            add(OFFICE, person.office, NOTICE)
    if owner.office and recipient.office and owner.office != recipient.office:
        add(OFFICE, owner.office, NOTICE)
        add(OFFICE, recipient.office, NOTICE)
    return sorted(
        (Review(unit_type, unit_id, kind) for (unit_type, unit_id), kind in found.items()),
        key=lambda review: (review.unit_type != BRANCH, review.kind != APPROVAL, review.unit_id),
    )
