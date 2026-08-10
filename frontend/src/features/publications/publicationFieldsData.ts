export interface PublicationDraft {
  title: string
  authors: string
  abstract: string
  publicationYear: string
  venue: string
  publicationType: string
  doi: string
  publisherUrl: string
  keywords: string
  isbn: string
  issn: string
  pubmedId: string
  arxivId: string
}

export const emptyPublicationDraft: PublicationDraft = {
  title: '',
  authors: '',
  abstract: '',
  publicationYear: '',
  venue: '',
  publicationType: '',
  doi: '',
  publisherUrl: '',
  keywords: '',
  isbn: '',
  issn: '',
  pubmedId: '',
  arxivId: '',
}

const BIBTEX_FIELD_MAP: Partial<Record<keyof PublicationDraft, string>> = {
  title: 'title',
  authors: 'authors',
  abstract: 'abstract',
  publicationYear: 'year',
  venue: 'venue',
  publicationType: 'publication_type',
  doi: 'doi',
  publisherUrl: 'url',
  keywords: 'keywords',
  isbn: 'isbn',
  issn: 'issn',
}

export function applyBibtexFields(
  draft: PublicationDraft,
  fields: Record<string, unknown>,
): PublicationDraft {
  const next = { ...draft }
  for (const [field, sourceKey] of Object.entries(BIBTEX_FIELD_MAP) as [
    keyof PublicationDraft,
    string,
  ][]) {
    const value = fields[sourceKey]
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) next[field] = text
  }
  return next
}

export function toPayload(draft: PublicationDraft) {
  return {
    title: draft.title.trim(),
    authors: draft.authors.trim() || null,
    abstract: draft.abstract.trim() || null,
    publicationYear: draft.publicationYear ? Number(draft.publicationYear) : null,
    venue: draft.venue.trim() || null,
    publicationType: draft.publicationType.trim() || null,
    doi: draft.doi.trim() || null,
    publisherUrl: draft.publisherUrl.trim() || null,
    keywords: draft.keywords.trim() || null,
    isbn: draft.isbn.trim() || null,
    issn: draft.issn.trim() || null,
    pubmedId: draft.pubmedId.trim() || null,
    arxivId: draft.arxivId.trim() || null,
  }
}
