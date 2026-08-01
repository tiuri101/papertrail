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

export function PublicationFieldInputs({
  draft,
  setField,
}: {
  draft: PublicationDraft
  setField: (field: keyof PublicationDraft) => (event: { target: { value: string } }) => void
}) {
  return (
    <>
      <label>
        Title
        <input value={draft.title} onChange={setField('title')} required />
      </label>
      <label>
        Authors
        <input value={draft.authors} onChange={setField('authors')} />
      </label>
      <label>
        Abstract
        <textarea value={draft.abstract} onChange={setField('abstract')} rows={4} />
      </label>
      <label>
        Year
        <input type="number" value={draft.publicationYear} onChange={setField('publicationYear')} />
      </label>
      <label>
        Venue
        <input value={draft.venue} onChange={setField('venue')} />
      </label>
      <label>
        Publication type
        <input value={draft.publicationType} onChange={setField('publicationType')} />
      </label>
      <label>
        DOI
        <input value={draft.doi} onChange={setField('doi')} />
      </label>
      <label>
        Publisher URL
        <input value={draft.publisherUrl} onChange={setField('publisherUrl')} />
      </label>
      <label>
        Keywords
        <input value={draft.keywords} onChange={setField('keywords')} />
      </label>
      <label>
        ISBN
        <input value={draft.isbn} onChange={setField('isbn')} />
      </label>
      <label>
        ISSN
        <input value={draft.issn} onChange={setField('issn')} />
      </label>
      <label>
        PubMed ID
        <input value={draft.pubmedId} onChange={setField('pubmedId')} />
      </label>
      <label>
        arXiv ID
        <input value={draft.arxivId} onChange={setField('arxivId')} />
      </label>
    </>
  )
}
