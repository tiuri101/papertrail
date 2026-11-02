from __future__ import annotations

from datetime import datetime

from pydantic import Field

from app.api.schemas import ApiModel


class BookmarkIdsResponse(ApiModel):
    publication_ids: list[str] = Field(serialization_alias="publicationIds")


class BookmarkSelection(ApiModel):
    publication_ids: list[str] = Field(alias="publicationIds", max_length=10_000)


class BookmarkExportRequest(ApiModel):
    # None exports every bookmark the user can still open.
    publication_ids: list[str] | None = Field(
        default=None, alias="publicationIds", max_length=10_000
    )


class BookmarkExportStatus(ApiModel):
    job_id: str = Field(serialization_alias="jobId")
    status: str
    error_message: str | None = Field(serialization_alias="errorMessage")
    filename: str | None
    publication_count: int | None = Field(serialization_alias="publicationCount")


class BookmarkItem(ApiModel):
    publication_id: str = Field(serialization_alias="publicationId")
    # Only used to build the link to the publication's page; the bookmarks
    # overview deliberately doesn't group or label rows by project.
    project_id: str = Field(serialization_alias="projectId")
    title: str
    authors: str | None
    publication_year: int | None = Field(serialization_alias="publicationYear")
    venue: str | None
    doi: str | None
    publisher_url: str | None = Field(serialization_alias="publisherUrl")
    bookmarked_at: datetime = Field(serialization_alias="bookmarkedAt")
