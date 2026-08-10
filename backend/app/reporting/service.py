"""Compatibility exports for reporting services."""

from app.reporting.bibtex import build_bibtex, publications_for_scope
from app.reporting.bundle import build_publication_bundle
from app.reporting.excel import build_excel, build_prisma_tables
from app.reporting.prisma import build_prisma_svg, calculate_prisma_counts
from app.reporting.results import build_final_results

__all__ = [
    "build_bibtex",
    "build_excel",
    "build_final_results",
    "build_prisma_svg",
    "build_prisma_tables",
    "build_publication_bundle",
    "calculate_prisma_counts",
    "publications_for_scope",
]
