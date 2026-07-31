"""Import all SQLAlchemy models so metadata is complete."""

from app.accounts.models import LoginThrottle, User, UserSession
from app.audit.models import AuditEvent
from app.conflicts.models import FinalDecision
from app.deduplication.models import DuplicateCandidate, PublicationMerge
from app.extraction.models import ExtractionResponse, ExtractionWorkItem
from app.forms.models import FormField, FormVersion, ReviewForm
from app.fulltext.models import FullTextRetrieval
from app.imports.models import ImportBatch, ImportedRecord, SearchSource
from app.jobs.models import BackgroundJob
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
    "Criterion",
    "DuplicateCandidate",
    "ExportArtifact",
    "ExtractionResponse",
    "ExtractionWorkItem",
    "FinalDecision",
    "FormField",
    "FormVersion",
    "FullTextRetrieval",
    "ImportBatch",
    "ImportedRecord",
    "LoginThrottle",
    "MetadataConflict",
    "Project",
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
