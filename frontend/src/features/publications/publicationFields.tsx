import { Input } from '../../components/Input'
import { Textarea } from '../../components/Textarea'
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
        <Input value={draft.title} onChange={setField('title')} required />
      </label>
      <label>
        Authors
        <Input value={draft.authors} onChange={setField('authors')} />
      </label>
      <label>
        Abstract
        <Textarea value={draft.abstract} onChange={setField('abstract')} rows={4} />
      </label>
      <label>
        Year
        <Input type="number" value={draft.publicationYear} onChange={setField('publicationYear')} />
      </label>
      <label>
        Venue
        <Input value={draft.venue} onChange={setField('venue')} />
      </label>
      <label>
        Publication type
        <Input value={draft.publicationType} onChange={setField('publicationType')} />
      </label>
      <label>
        DOI
        <Input value={draft.doi} onChange={setField('doi')} />
      </label>
      <label>
        Publisher URL
        <Input value={draft.publisherUrl} onChange={setField('publisherUrl')} />
      </label>
      <label>
        Keywords
        <Input value={draft.keywords} onChange={setField('keywords')} />
      </label>
      <label>
        ISBN
        <Input value={draft.isbn} onChange={setField('isbn')} />
      </label>
      <label>
        ISSN
        <Input value={draft.issn} onChange={setField('issn')} />
      </label>
      <label>
        PubMed ID
        <Input value={draft.pubmedId} onChange={setField('pubmedId')} />
      </label>
      <label>
        arXiv ID
        <Input value={draft.arxivId} onChange={setField('arxivId')} />
      </label>
    </>
  )
}
