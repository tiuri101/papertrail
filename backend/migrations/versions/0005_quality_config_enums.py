"""constrain quality_configs.mode and .aggregation to their known values

``mode`` and ``aggregation`` were free-text VARCHARs that the API accepted
verbatim from the request body. Nothing rejected an unrecognized value; it was
simply reinterpreted downstream -- any aggregation other than
``weighted_average``/``average`` fell through to a plain sum, and any mode
other than ``numeric``/``both`` behaved as ``qualitative`` (no score computed
at all). A typo therefore produced plausible-looking but wrong scores instead
of an error.

Both columns are now typed enums in the ORM, which makes an unrecognized value
fail loudly on read as well as on write -- so any such value already sitting in
a database has to be resolved before the constraint is added, or the next read
of that row raises.

The normalization deliberately maps each unrecognized value to the one that
*preserves the behavior that row already had*, rather than to the column
default: an unknown ``mode`` behaved as ``qualitative``, and an unknown
``aggregation`` behaved as ``sum``. No stored score changes, and no row is
deleted. The dev database checked before writing this revision held no
``quality_configs`` rows at all, and a correctly-configured project only ever
stores one of the listed values, so this is expected to be a no-op in
practice; it exists for databases that were written to before the API
validated the field.

Revision ID: 0005_quality_config_enums
Revises: 0004_final_decision_unique
Create Date: 2026-08-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_quality_config_enums"
down_revision: str | None = "0004_final_decision_unique"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MODE_VALUES = ("qualitative", "numeric", "both")
AGGREGATION_VALUES = ("sum", "average", "weighted_average")

# Short names: the metadata naming convention
# (``ck_%(table_name)s_%(constraint_name)s``) expands them on both create and
# drop into ``ck_quality_configs_<name>``.
MODE_CONSTRAINT = "qualitymode"
AGGREGATION_CONSTRAINT = "qualityaggregation"


def _in_list(values: Sequence[str]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE quality_configs SET mode = 'qualitative' "
            f"WHERE mode NOT IN ({_in_list(MODE_VALUES)})"
        )
    )
    bind.execute(
        sa.text(
            "UPDATE quality_configs SET aggregation = 'sum' "
            f"WHERE aggregation NOT IN ({_in_list(AGGREGATION_VALUES)})"
        )
    )
    op.create_check_constraint(
        MODE_CONSTRAINT,
        "quality_configs",
        sa.text(f"mode IN ({_in_list(MODE_VALUES)})"),
    )
    op.create_check_constraint(
        AGGREGATION_CONSTRAINT,
        "quality_configs",
        sa.text(f"aggregation IN ({_in_list(AGGREGATION_VALUES)})"),
    )


def downgrade() -> None:
    # op.drop_constraint applies the same metadata naming convention
    # ("ck_%(table_name)s_%(constraint_name)s") that create_check_constraint
    # used, so it takes the same short name -- passing the already-expanded
    # name here would expand it a second time and fail to find the constraint.
    op.drop_constraint(AGGREGATION_CONSTRAINT, "quality_configs", type_="check")
    op.drop_constraint(MODE_CONSTRAINT, "quality_configs", type_="check")
