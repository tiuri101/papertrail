"""Per-user opt-outs for optional email categories.

Every email template is either *mandatory* (account and security mail the
recipient cannot turn off) or belongs to exactly one optional category a user
can disable under Account Settings. ``queue_email_notification`` consults
:func:`wants_email` for every message, so a new template has to be classified
here before it can be sent -- an unclassified template is rejected rather than
silently becoming un-mutable.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.accounts.models import User

#: Account and security mail: always delivered, never listed as a preference.
MANDATORY_TEMPLATES = frozenset({"account_created", "password_reset"})


@dataclass(frozen=True)
class EmailCategory:
    key: str
    templates: frozenset[str]


EMAIL_CATEGORIES: tuple[EmailCategory, ...] = (
    EmailCategory("llm_processing", frozenset({"llm_stage_completed"})),
    EmailCategory("imports", frozenset({"import_completed", "import_failed"})),
    EmailCategory("duplicate_detection", frozenset({"duplicate_detection_failed"})),
    EmailCategory(
        "project_progress",
        frozenset({"project_stage_completed", "project_completed"}),
    ),
    EmailCategory(
        "project_membership",
        frozenset({"project_membership_added", "project_membership_removed"}),
    ),
    EmailCategory(
        "project_copies",
        frozenset({"project_copy_completed", "project_copy_failed"}),
    ),
    EmailCategory("new_projects", frozenset({"project_created"})),
)

EMAIL_CATEGORY_KEYS = frozenset(category.key for category in EMAIL_CATEGORIES)

_CATEGORY_BY_TEMPLATE = {
    template: category.key
    for category in EMAIL_CATEGORIES
    for template in category.templates
}


def category_for_template(template: str) -> str | None:
    """The optional category ``template`` belongs to, or ``None`` if mandatory."""
    if template in MANDATORY_TEMPLATES:
        return None
    try:
        return _CATEGORY_BY_TEMPLATE[template]
    except KeyError:
        raise ValueError(
            f"Email template {template!r} is not assigned to an email category"
        ) from None


def resolved_email_preferences(user: User) -> dict[str, bool]:
    """Every optional category with the user's choice, defaulting to enabled."""
    stored = user.email_preferences or {}
    return {key: bool(stored.get(key, True)) for key in sorted(EMAIL_CATEGORY_KEYS)}


def wants_email(user: User, template: str) -> bool:
    category = category_for_template(template)
    if category is None:
        return True
    return bool((user.email_preferences or {}).get(category, True))
