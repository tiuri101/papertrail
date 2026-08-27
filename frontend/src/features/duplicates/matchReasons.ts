const MATCH_REASON_LABELS: Record<string, string> = {
  exact_doi: 'Exact DOI',
  exact_pubmed_id: 'Exact PubMed ID',
  exact_arxiv_id: 'Exact arXiv ID',
  exact_title: 'Exact title match',
  similar_title: 'Similar title',
  similar_title_authors: 'Similar title & authors',
  similar_title_year: 'Similar title & year',
  shared_isbn: 'Shared ISBN',
  shared_issn: 'Shared ISSN',
  provider_confirmed: 'Confirmed by Crossref / Semantic Scholar',
}

export function humanizeMatchReason(reason: string): string {
  return MATCH_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ')
}
