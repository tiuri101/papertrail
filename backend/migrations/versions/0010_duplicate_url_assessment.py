"""url reachability checks + provider resolution hints for duplicate review

The duplicate-review stage gains an external-provider assist. A new
``assess_duplicate_candidates`` background job, for every publication that is
part of an *unresolved* duplicate candidate:

* probes the record's ``publisher_url`` and its DOI URL and records whether
  each still resolves (``publication_url_checks``) -- a dead link on one side
  is a signal for keeping the other record;
* looks each side's DOI up on Crossref / Semantic Scholar. A provider-confirmed
  same-work match is merged automatically; anything short of that is stored on
  the candidate as a non-binding recommendation (``provider_recommendation`` and
  the accompanying ``provider_*`` columns) that the review UI shows next to the
  reviewer's own buttons.

All new columns are nullable and start empty: an existing candidate is simply
un-assessed until the job runs.

Revision ID: 0010_duplicate_url_assessment
Revises: 0009_duplicate_reservation_lease
Create Date: 2026-08-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010_duplicate_url_assessment"
down_revision: str | None = "0009_duplicate_reservation_lease"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "publication_url_checks",
        sa.Column("publication_id", sa.String(length=36), nullable=False),
        sa.Column("url_kind", sa.String(length=20), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("reachable", sa.Boolean(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.ForeignKeyConstraint(
            ["publication_id"],
            ["publications.id"],
            name=op.f("fk_publication_url_checks_publication_id_publications"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_publication_url_checks")),
        sa.UniqueConstraint(
            "publication_id", "url_kind", name="uq_url_check_kind"
        ),
    )
    op.create_index(
        op.f("ix_publication_url_checks_publication_id"),
        "publication_url_checks",
        ["publication_id"],
        unique=False,
    )

    op.add_column(
        "duplicate_candidates",
        sa.Column("provider_recommendation", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "duplicate_candidates",
        sa.Column(
            "provider_recommended_canonical_id",
            sa.String(length=36),
            nullable=True,
        ),
    )
    op.add_column(
        "duplicate_candidates",
        sa.Column("provider_recommendation_reason", sa.Text(), nullable=True),
    )
    op.add_column(
        "duplicate_candidates",
        sa.Column(
            "provider_recommendation_source", sa.String(length=50), nullable=True
        ),
    )
    op.add_column(
        "duplicate_candidates",
        sa.Column(
            "provider_assessed_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.create_foreign_key(
        "fk_dup_candidate_provider_canonical",
        "duplicate_candidates",
        "publications",
        ["provider_recommended_canonical_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_dup_candidate_provider_canonical",
        "duplicate_candidates",
        type_="foreignkey",
    )
    op.drop_column("duplicate_candidates", "provider_assessed_at")
    op.drop_column("duplicate_candidates", "provider_recommendation_source")
    op.drop_column("duplicate_candidates", "provider_recommendation_reason")
    op.drop_column("duplicate_candidates", "provider_recommended_canonical_id")
    op.drop_column("duplicate_candidates", "provider_recommendation")

    op.drop_index(
        op.f("ix_publication_url_checks_publication_id"),
        table_name="publication_url_checks",
    )
    op.drop_table("publication_url_checks")
