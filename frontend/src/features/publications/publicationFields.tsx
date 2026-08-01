import type { PublicationDraft } from './publicationFieldsData'

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
