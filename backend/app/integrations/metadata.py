from __future__ import annotations

from typing import Any

import httpx


class CrossrefClient:
    base_url = "https://api.crossref.org"

    def __init__(self, timeout: float = 15.0) -> None:
        self.timeout = timeout

    def lookup_doi(self, doi: str) -> dict[str, Any]:
        with httpx.Client(timeout=self.timeout, headers={"User-Agent": "Papertrail/0.1 (mailto:admin@example.invalid)"}) as client:
            response = client.get(f"{self.base_url}/works/{doi}")
            response.raise_for_status()
            item = response.json()["message"]
        return self._map(item)

    def search(self, title: str, authors: str | None = None) -> list[dict[str, Any]]:
        query = title if not authors else f"{title} {authors}"
        with httpx.Client(timeout=self.timeout) as client:
            response = client.get(f"{self.base_url}/works", params={"query.bibliographic": query, "rows": 5})
            response.raise_for_status()
            return [self._map(item) for item in response.json()["message"]["items"]]

    @staticmethod
    def _map(item: dict[str, Any]) -> dict[str, Any]:
        authors = "; ".join(" ".join(filter(None, [a.get("given"), a.get("family")])) for a in item.get("author", [])) or None
        year = None
        parts = (item.get("published-print") or item.get("published-online") or {}).get("date-parts", [])
        if parts and parts[0]:
            year = parts[0][0]
        return {"title": (item.get("title") or [None])[0], "authors": authors, "abstract": item.get("abstract"), "publication_year": year, "venue": (item.get("container-title") or [None])[0], "doi": item.get("DOI"), "publisher_url": item.get("URL"), "publication_type": item.get("type")}


class SemanticScholarClient:
    base_url = "https://api.semanticscholar.org/graph/v1"
    fields = "title,authors,abstract,year,venue,externalIds,url,publicationTypes"

    def __init__(self, api_key: str | None = None, timeout: float = 15.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    def lookup_doi(self, doi: str) -> dict[str, Any]:
        headers = {"x-api-key": self.api_key} if self.api_key else {}
        with httpx.Client(timeout=self.timeout, headers=headers) as client:
            response = client.get(f"{self.base_url}/paper/DOI:{doi}", params={"fields": self.fields})
            response.raise_for_status()
            return self._map(response.json())

    def search(self, title: str, authors: str | None = None) -> list[dict[str, Any]]:
        headers = {"x-api-key": self.api_key} if self.api_key else {}
        with httpx.Client(timeout=self.timeout, headers=headers) as client:
            response = client.get(f"{self.base_url}/paper/search", params={"query": title, "limit": 5, "fields": self.fields})
            response.raise_for_status()
            return [self._map(item) for item in response.json().get("data", [])]

    @staticmethod
    def _map(item: dict[str, Any]) -> dict[str, Any]:
        ids = item.get("externalIds") or {}
        return {"title": item.get("title"), "authors": "; ".join(a.get("name", "") for a in item.get("authors", [])) or None, "abstract": item.get("abstract"), "publication_year": item.get("year"), "venue": item.get("venue"), "doi": ids.get("DOI"), "publisher_url": item.get("url"), "publication_type": "; ".join(item.get("publicationTypes") or []) or None}
