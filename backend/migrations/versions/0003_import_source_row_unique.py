"""one imported record per source row of an import batch

Makes the import invariant a database rule: a logical source row of an
uploaded bibliographic file may produce at most one ``imported_records`` row,
however often the ``parse_import`` job is retried and however many workers end
up running it at once after a lease expiry.

Before this revision the parse job restarted at row 1 on every retry while
committing every 100 rows, so a failure part-way through a large batch
duplicated every row an earlier attempt had already committed. Existing
databases can therefore hold rows that violate the new constraint, and those
duplicates have usually already been normalized into duplicate publications.
The upgrade cleans that up deterministically before adding the constraint:

1. Within each ``(import_batch_id, source_row)`` group it keeps one record --
   preferring one that a ``publication_sources`` row already points at, then
   the oldest, then the lowest id -- and discards the rest.
2. It notes which publications were sourced *only* from the discarded records.
3. It deletes the discarded records; ``publication_sources`` cascades.
4. Publications from step 2 that are left with no source at all are
   deactivated (``is_active = false``), the same soft removal a search
   deletion performs. They are duplicates that only ever existed because of
   the retry bug; publications that still have any other source, and
   publications that were never import-sourced, are untouched.

Nothing is hard-deleted apart from the duplicate import rows themselves, so
the merge/screening history attached to surviving publications is preserved.

Revision ID: 0003_import_source_row_unique
Revises: 0002_encrypted_email_payload
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_import_source_row_unique"
down_revision: str | None = "0002_encrypted_email_payload"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONSTRAINT_NAME = "uq_imported_records_batch_source_row"

# One row per record that must go: everything but the preferred survivor of
# each duplicated (import_batch_id, source_row) group.
_DUPLICATE_RECORD_IDS = sa.text(
    """
    SELECT id
    FROM (
        SELECT
            r.id AS id,
            ROW_NUMBER() OVER (
                PARTITION BY r.import_batch_id, r.source_row
                ORDER BY
                    (
                        SELECT COUNT(*)
                        FROM publication_sources ps
                        WHERE ps.imported_record_id = r.id
                    ) DESC,
                    r.created_at ASC,
                    r.id ASC
            ) AS duplicate_rank
        FROM imported_records r
        WHERE r.source_row IS NOT NULL
    ) ranked
    WHERE ranked.duplicate_rank > 1
    """
)


def upgrade() -> None:
    connection = op.get_bind()
    duplicate_ids = [row[0] for row in connection.execute(_DUPLICATE_RECORD_IDS)]
    if duplicate_ids:
        publication_ids = [
            row[0]
            for row in connection.execute(
                sa.text(
                    "SELECT DISTINCT publication_id FROM publication_sources "
                    "WHERE imported_record_id IN :ids"
                ).bindparams(sa.bindparam("ids", duplicate_ids, expanding=True))
            )
        ]
        connection.execute(
            sa.text("DELETE FROM imported_records WHERE id IN :ids").bindparams(
                sa.bindparam("ids", duplicate_ids, expanding=True)
            )
        )
        if publication_ids:
            connection.execute(
                sa.text(
                    """
                    UPDATE publications
                    SET is_active = false
                    WHERE id IN :ids
                      AND is_active = true
                      AND NOT EXISTS (
                          SELECT 1 FROM publication_sources ps
                          WHERE ps.publication_id = publications.id
                      )
                    """
                ).bindparams(sa.bindparam("ids", publication_ids, expanding=True))
            )
    op.create_unique_constraint(
        CONSTRAINT_NAME,
        "imported_records",
        ["import_batch_id", "source_row"],
    )


def downgrade() -> None:
    op.drop_constraint(CONSTRAINT_NAME, "imported_records", type_="unique")
