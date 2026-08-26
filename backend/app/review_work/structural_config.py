"""Freezing structural review configuration once a stage's work exists.

A stage's *structural* settings are the ones its generated work items are a
direct function of: how many reviewer slots each publication gets, and
whether those slots are pre-assigned to reviewers or claimed from a shared
pool.  Work items are generated once, when a stage is initialized, and
nothing revisits that generation afterwards -- so changing a structural
setting later does not reshape the existing items, it only makes the queues
reinterpret them under rules they were never built for:

* raising the required reviewer count leaves every already-enrolled
  publication permanently one slot short, so its quorum can never be reached;
* switching a pre-assigned stage to claim mode strands every existing item,
  because the claim query only ever offers *unassigned* slots -- the work
  disappears from every reviewer's queue at once;
* switching claim mode to pre-assigned leaves the open pool unassigned and
  therefore invisible, since a pre-assigned queue only shows a reviewer the
  slots bearing their own id.

The policy is to reject such a change outright rather than half-migrate it
inside an ordinary settings update: the rejection carries a distinct error
code (``structural_setting_locked``) plus the offending setting, so a client
can freeze exactly that control instead of guessing at a generic 400.
Non-structural settings -- conflict/uncertain resolution policy and anything
else that only governs how decisions are *interpreted* -- stay editable at
any point in a project's life, because they never determine which work items
exist.

Domains expose their own thin "has work started for this stage" predicate
over :func:`work_items_exist` (``app.screening.service.screening_work_started``,
``app.extraction.service.extraction_work_started``) so each keeps ownership of
what "its work" means, while sharing this policy and error shape.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session

from app.api.errors import DomainError


class StructuralSettingLockedError(DomainError):
    """A structural allocation setting was changed after work items existed.

    409 rather than 400: the request is well-formed and would have been valid
    earlier: it conflicts with state the project has since acquired.
    """

    status_code = 409
    code = "structural_setting_locked"

    def __init__(self, message: str, *, setting: str, stage: str | None = None) -> None:
        details: dict[str, Any] = {"setting": setting}
        if stage is not None:
            details["stage"] = stage
        super().__init__(message, details=details)
        self.setting = setting
        self.stage = stage


def work_items_exist(db: Session, id_column: Any, *filters: ColumnElement[bool]) -> bool:
    """Whether any row matching ``filters`` exists, without loading it."""
    return db.scalar(select(id_column).where(*filters).limit(1)) is not None
