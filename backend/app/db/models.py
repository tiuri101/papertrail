"""Import all SQLAlchemy models so metadata is complete."""

from app.accounts.models import LoginThrottle, User, UserSession
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval, PublicationDocument
from app.imports.models import ImportBatch, ImportedRecord, ImportPdfItem, SearchSource
from app.jobs.models import BackgroundJob
from app.llm.models import (
    DocumentPageText,
    DocumentTextExtraction,
    ExtractionSuggestionReview,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmSchemaField,
    LlmSchemaVersion,
    ProjectLlmSettings,
)
from app.projects.models import (
    Criterion,
    Project,
    ProjectMembership,
    ResearchQuestion,
    ScreeningConfig,
)
from app.publications.models import MetadataConflict, Publication, PublicationSource
from app.quality.models import QualityConfig, QualityResponse, QualityWorkItem
from app.reporting.models import ExportArtifact
from app.screening.models import ScreeningDecision, ScreeningWorkItem

__all__ = [
    "AuditEvent",
    "BackgroundJob",
    "DocumentPageText",
    "DocumentTextExtraction",
    "Criterion",
    "DuplicateCandidate",
    "ExportArtifact",
    "ExtractionResponse",
    "ExtractionWorkItem",
    "ExtractionSuggestionReview",
    "FinalDecision",
    "FormField",
    "FormVersion",
    "FullTextRetrieval",
    "PublicationDocument",
    "ImportBatch",
    "ImportPdfItem",
    "ImportedRecord",
    "LoginThrottle",
    "LlmExtractionRun",
    "LlmFieldSuggestion",
    "LlmSchemaField",
    "LlmSchemaVersion",
    "MetadataConflict",
    "Project",
    "ProjectLlmSettings",
    "ProjectMembership",
    "Publication",
    "PublicationMerge",
    "PublicationSource",
    "QualityConfig",
    "QualityResponse",
    "QualityWorkItem",
    "ResearchQuestion",
    "ReviewForm",
    "ScreeningConfig",
    "ScreeningDecision",
    "ScreeningWorkItem",
    "SearchSource",
    "User",
    "UserSession",
]
