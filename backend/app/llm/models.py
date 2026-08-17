from __future__ import annotations

import enum
from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.db.types import JSONType


class ProcessingStatus(enum.StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    UNSUPPORTED = "unsupported"
    STALE = "stale"
    CANCELLED = "cancelled"


class SchemaStatus(enum.StrEnum):
    DRAFT = "draft"
    PUBLISHED = "published"
    SUPERSEDED = "superseded"


class SuggestionStatus(enum.StrEnum):
    EXPLICIT = "explicit"
    INFERRED = "inferred"
    AMBIGUOUS = "ambiguous"
    NOT_FOUND = "not_found"
    NOT_APPLICABLE = "not_applicable"


class EvidenceStatus(enum.StrEnum):
    VERIFIED = "verified"
    PARTIAL = "partial"
    UNVERIFIED = "unverified"
    NOT_REQUIRED = "not_required"


class SuggestionDisposition(enum.StrEnum):
    ACCEPTED = "accepted"
    MODIFIED = "modified"
    REPLACED = "replaced"
    NOT_USED = "not_used"
    MANUAL = "manual"


class LlmTaskType(enum.StrEnum):
    TITLE_ABSTRACT_SCREENING = "title_abstract_screening"
    FULL_TEXT_SCREENING = "full_text_screening"
    DATA_EXTRACTION = "data_extraction"
    EXTRACTION_VALIDATION = "extraction_validation"


class CriterionAssessment(enum.StrEnum):
    MET = "met"
    NOT_MET = "not_met"
    UNCLEAR = "unclear"


class ValidationAssessment(enum.StrEnum):
    SUPPORTED = "supported"
    CONTRADICTED = "contradicted"
    UNCERTAIN = "uncertain"
    NOT_VERIFIABLE = "not_verifiable"


class ProjectLlmSettings(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "project_llm_settings"
    __table_args__ = (UniqueConstraint("project_id", name="uq_project_llm_settings"),)

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    title_abstract_screening_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    full_text_screening_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    extraction_validation_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    analysis_narrative_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    current_schema_version_id: Mapped[str | None] = mapped_column(
        String(36), index=True
    )
    updated_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class LlmInstallationSettings(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Administrator-managed overrides for installation-wide LLM defaults."""

    __tablename__ = "llm_installation_settings"

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    endpoint: Mapped[str | None] = mapped_column(String(2000))
    model: Mapped[str | None] = mapped_column(String(250))
    context_length: Mapped[int] = mapped_column(Integer, nullable=False)
    title_abstract_base_prompt: Mapped[str | None] = mapped_column(Text)
    full_text_base_prompt: Mapped[str | None] = mapped_column(Text)
    extraction_base_prompt: Mapped[str | None] = mapped_column(Text)
    validation_base_prompt: Mapped[str | None] = mapped_column(Text)
    updated_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )


class LlmSchemaVersion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_schema_versions"
    __table_args__ = (
        UniqueConstraint("project_id", "version_number", name="uq_llm_schema_version"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[SchemaStatus] = mapped_column(
        String(20), default=SchemaStatus.DRAFT, index=True, nullable=False
    )
    based_on_form_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("form_versions.id", ondelete="SET NULL"), index=True
    )
    created_by_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    fields: Mapped[list[LlmSchemaField]] = relationship(
        back_populates="schema_version",
        cascade="all, delete-orphan",
        order_by="LlmSchemaField.position",
    )


class LlmSchemaField(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_schema_fields"
    __table_args__ = (
        UniqueConstraint(
            "schema_version_id", "stable_key", name="uq_llm_schema_field_key"
        ),
    )

    schema_version_id: Mapped[str] = mapped_column(
        ForeignKey("llm_schema_versions.id", ondelete="CASCADE"), index=True
    )
    stable_key: Mapped[str] = mapped_column(
        String(36), default=lambda: str(uuid4()), index=True, nullable=False
    )
    label: Mapped[str] = mapped_column(String(300), nullable=False)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    field_type: Mapped[str] = mapped_column(String(40), nullable=False)
    mapped_extraction_field_key: Mapped[str | None] = mapped_column(
        String(36), index=True
    )
    options: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    evidence_required: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    allow_inferred: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    schema_version: Mapped[LlmSchemaVersion] = relationship(back_populates="fields")


class DocumentTextExtraction(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "document_text_extractions"
    __table_args__ = (
        UniqueConstraint("document_id", name="uq_document_text_document"),
    )

    document_id: Mapped[str] = mapped_column(
        ForeignKey("publication_documents.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[ProcessingStatus] = mapped_column(
        String(20), default=ProcessingStatus.PENDING, index=True, nullable=False
    )
    extractor: Mapped[str] = mapped_column(String(100), nullable=False)
    extractor_version: Mapped[str] = mapped_column(String(50), nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_chars: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    extracted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)

    pages: Mapped[list[DocumentPageText]] = relationship(
        back_populates="extraction",
        cascade="all, delete-orphan",
        order_by="DocumentPageText.page_number",
    )


class DocumentPageText(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "document_page_texts"
    __table_args__ = (
        UniqueConstraint("text_extraction_id", "page_number", name="uq_document_page"),
    )

    text_extraction_id: Mapped[str] = mapped_column(
        ForeignKey("document_text_extractions.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    extraction: Mapped[DocumentTextExtraction] = relationship(back_populates="pages")


class LlmExtractionRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_extraction_runs"
    __table_args__ = (
        Index(
            "uq_llm_active_run",
            "publication_id",
            "task_type",
            "input_fingerprint",
            unique=True,
            postgresql_where=text("status IN ('pending', 'processing')"),
            sqlite_where=text("status IN ('pending', 'processing')"),
        ),
        Index("ix_llm_runs_project_status", "project_id", "status"),
        Index("ix_llm_runs_publication_created", "publication_id", "created_at"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    task_type: Mapped[LlmTaskType] = mapped_column(
        String(40), default=LlmTaskType.DATA_EXTRACTION, index=True, nullable=False
    )
    bulk_id: Mapped[str | None] = mapped_column(String(36), index=True)
    input_fingerprint: Mapped[str | None] = mapped_column(String(64), index=True)
    document_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_documents.id", ondelete="CASCADE"), index=True
    )
    schema_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("llm_schema_versions.id", ondelete="RESTRICT"), index=True
    )
    text_extraction_id: Mapped[str | None] = mapped_column(
        ForeignKey("document_text_extractions.id", ondelete="RESTRICT"), index=True
    )
    extraction_response_id: Mapped[str | None] = mapped_column(
        ForeignKey("extraction_responses.id", ondelete="SET NULL"), index=True
    )
    provider: Mapped[str] = mapped_column(String(40), default="ollama", nullable=False)
    model: Mapped[str] = mapped_column(String(250), nullable=False)
    model_configuration: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    prompt_template_version: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[ProcessingStatus] = mapped_column(
        String(20), default=ProcessingStatus.PENDING, index=True, nullable=False
    )
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_type: Mapped[str | None] = mapped_column(String(100))
    error_message: Mapped[str | None] = mapped_column(Text)
    raw_result: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    total_duration: Mapped[int | None] = mapped_column(BigInteger)
    load_duration: Mapped[int | None] = mapped_column(BigInteger)
    prompt_eval_count: Mapped[int | None] = mapped_column()
    prompt_eval_duration: Mapped[int | None] = mapped_column(BigInteger)
    eval_count: Mapped[int | None] = mapped_column()
    eval_duration: Mapped[int | None] = mapped_column(BigInteger)
    background_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("background_jobs.id", ondelete="SET NULL"), index=True
    )

    suggestions: Mapped[list[LlmFieldSuggestion]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    criterion_suggestions: Mapped[list[LlmCriterionSuggestion]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    validation_results: Mapped[list[LlmValidationResult]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class LlmFieldSuggestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_field_suggestions"
    __table_args__ = (
        UniqueConstraint("run_id", "schema_field_id", name="uq_llm_run_field"),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("llm_extraction_runs.id", ondelete="CASCADE"), index=True
    )
    schema_field_id: Mapped[str] = mapped_column(
        ForeignKey("llm_schema_fields.id", ondelete="RESTRICT"), index=True
    )
    mapped_extraction_field_key: Mapped[str | None] = mapped_column(
        String(36), index=True
    )
    value: Mapped[object | None] = mapped_column(JSONType)
    status: Mapped[SuggestionStatus] = mapped_column(String(20), nullable=False)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    evidence_validation_status: Mapped[EvidenceStatus] = mapped_column(
        String(20), nullable=False
    )

    run: Mapped[LlmExtractionRun] = relationship(back_populates="suggestions")


class ExtractionSuggestionReview(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "extraction_suggestion_reviews"
    __table_args__ = (
        UniqueConstraint(
            "extraction_response_id",
            "extraction_field_key",
            name="uq_extraction_suggestion_review",
        ),
    )

    extraction_response_id: Mapped[str | None] = mapped_column(
        ForeignKey("extraction_responses.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("publications.id", ondelete="CASCADE"), index=True
    )
    reviewer_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    response_version: Mapped[int] = mapped_column(Integer, nullable=False)
    extraction_field_key: Mapped[str] = mapped_column(String(36), index=True)
    suggestion_id: Mapped[str | None] = mapped_column(
        ForeignKey("llm_field_suggestions.id", ondelete="SET NULL"), index=True
    )
    reviewer_final_value: Mapped[object | None] = mapped_column(JSONType)
    reviewer_final_value_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    disposition: Mapped[SuggestionDisposition] = mapped_column(
        String(20), nullable=False
    )


class LlmCriterionSuggestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_criterion_suggestions"
    __table_args__ = (
        UniqueConstraint("run_id", "criterion_id", name="uq_llm_run_criterion"),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("llm_extraction_runs.id", ondelete="CASCADE"), index=True
    )
    criterion_id: Mapped[str | None] = mapped_column(
        ForeignKey("criteria.id", ondelete="SET NULL"), index=True
    )
    criterion_text: Mapped[str] = mapped_column(Text, nullable=False)
    criterion_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    assessment: Mapped[CriterionAssessment] = mapped_column(String(20), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    evidence_validation_status: Mapped[EvidenceStatus] = mapped_column(
        String(20), nullable=False
    )

    run: Mapped[LlmExtractionRun] = relationship(back_populates="criterion_suggestions")


class LlmValidationResult(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "llm_validation_results"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "extraction_field_key", name="uq_llm_validation_field"
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("llm_extraction_runs.id", ondelete="CASCADE"), index=True
    )
    extraction_field_key: Mapped[str] = mapped_column(String(36), index=True)
    field_label: Mapped[str] = mapped_column(String(300), nullable=False)
    value_snapshot: Mapped[object | None] = mapped_column(JSONType)
    assessment: Mapped[ValidationAssessment] = mapped_column(String(30), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONType, default=list, nullable=False
    )
    evidence_validation_status: Mapped[EvidenceStatus] = mapped_column(
        String(20), nullable=False
    )

    run: Mapped[LlmExtractionRun] = relationship(back_populates="validation_results")
