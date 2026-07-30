"""Create project configuration tables.

Revision ID: 0002_projects
Revises: 0001_accounts
"""
import sqlalchemy as sa
from alembic import op

revision = "0002_projects"
down_revision = "0001_accounts"
branch_labels = None
depends_on = None

review_type = sa.Enum(
    "SYSTEMATIC_REVIEW",
    "SCOPING_REVIEW",
    "SYSTEMATIC_MAPPING",
    "OTHER",
    name="reviewtype",
)
project_stage = sa.Enum(
    "DRAFT",
    "DUPLICATE_REVIEW",
    "TITLE_ABSTRACT",
    "FULL_TEXT",
    "EXTRACTION",
    "COMPLETED",
    name="projectstage",
)
criterion_kind = sa.Enum("INCLUSION", "EXCLUSION", name="criterionkind")
screening_stage = sa.Enum("TITLE_ABSTRACT", "FULL_TEXT", name="screeningstage")
allocation_mode = sa.Enum("INDEPENDENT", "DIVIDED", name="allocationmode")
resolution_method = sa.Enum(
    "DISCUSSION_CONSENSUS",
    "ADMIN_CONSENSUS",
    "ADDITIONAL_REVIEWER",
    "ADJUDICATOR",
    "MAJORITY",
    name="resolutionmethod",
)


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(250), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("review_type", review_type, nullable=False),
        sa.Column("stage", project_stage, nullable=False),
        sa.Column("random_seed", sa.String(128), nullable=False),
        sa.Column("configuration_ready", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "project_memberships",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("can_title_abstract_screen", sa.Boolean(), nullable=False),
        sa.Column("can_full_text_screen", sa.Boolean(), nullable=False),
        sa.Column("can_extract", sa.Boolean(), nullable=False),
        sa.Column("can_assess_quality", sa.Boolean(), nullable=False),
        sa.Column("can_adjudicate", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_membership"),
    )
    op.create_table(
        "research_questions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "criteria",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", criterion_kind, nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "screening_configs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("stage", screening_stage, nullable=False),
        sa.Column("required_reviewers", sa.Integer(), nullable=False),
        sa.Column("allocation_mode", allocation_mode, nullable=False),
        sa.Column("conflict_resolution", resolution_method, nullable=False),
        sa.Column("uncertain_resolution", resolution_method, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("project_id", "stage", name="uq_screening_config_stage"),
    )
    op.create_table(
        "exclusion_reasons",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "project_id",
            sa.String(36),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("stage", screening_stage, nullable=False),
        sa.Column("label", sa.String(300), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    for table in [
        "exclusion_reasons",
        "screening_configs",
        "criteria",
        "research_questions",
        "project_memberships",
        "projects",
    ]:
        op.drop_table(table)
    for enum in [
        resolution_method,
        allocation_mode,
        screening_stage,
        criterion_kind,
        project_stage,
        review_type,
    ]:
        enum.drop(op.get_bind(), checkfirst=True)
