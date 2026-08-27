"""Import all SQLAlchemy models so metadata is complete."""

from app.accounts.models import LoginThrottle, PasswordResetToken, User, UserSession
from app.analysis.models import StageAnalysis
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import (
    DuplicateCandidate,
    PublicationMerge,
    PublicationUrlCheck,
)
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval, PublicationDocument
from app.imports.models import ImportBatch, ImportedRecord, ImportPdfItem, SearchSource
from app.instance_settings.models import InstanceSettings
from app.jobs.models import BackgroundJob
from app.llm.models import (
    DocumentPageText,
    DocumentTextExtraction,
    ExtractionSuggestionReview,
    LlmCriterionSuggestion,
    LlmExtractionRun,
    LlmFieldSuggestion,
    LlmInstallationSettings,
    LlmSchemaField,
    LlmSchemaVersion,
    LlmValidationResult,
    ProjectLlmSettings,
)
from app.notifications.models import EmailNotification
from app.pdf_acquisition.models import (
    BrowserAgent,
    BrowserAgentPairing,
    PdfRetrievalBatch,
    PdfRetrievalJob,
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
    "BrowserAgent",
    "BrowserAgentPairing",
    "DocumentPageText",
    "DocumentTextExtraction",
    "EmailNotification",
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
    "InstanceSettings",
    "LoginThrottle",
    "LlmExtractionRun",
    "LlmCriterionSuggestion",
    "LlmFieldSuggestion",
    "LlmInstallationSettings",
    "LlmSchemaField",
    "LlmSchemaVersion",
    "LlmValidationResult",
    "MetadataConflict",
    "Project",
    "ProjectLlmSettings",
    "ProjectMembership",
    "PasswordResetToken",
    "PdfRetrievalBatch",
    "PdfRetrievalJob",
    "Publication",
    "PublicationMerge",
    "PublicationSource",
    "PublicationUrlCheck",
    "QualityConfig",
    "QualityResponse",
    "QualityWorkItem",
    "ResearchQuestion",
    "ReviewForm",
    "ScreeningConfig",
    "ScreeningDecision",
    "ScreeningWorkItem",
    "SearchSource",
    "StageAnalysis",
    "User",
    "UserSession",
]
