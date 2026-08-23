import { Input } from '../../components/Input'
import { Textarea } from '../../components/Textarea'
import type { PublicationDraft } from './publicationFieldsData'
import { FieldLabel } from '../../components/FieldLabel'

export function PublicationFieldInputs({
  draft,
  setField,
}: {
  draft: PublicationDraft
  setField: (field: keyof PublicationDraft) => (event: { target: { value: string } }) => void
}) {
  return (
    <>
      <FieldLabel>
        Title
        <Input value={draft.title} onChange={setField('title')} required />
      </FieldLabel>
      <FieldLabel>
        Authors
        <Input value={draft.authors} onChange={setField('authors')} />
      </FieldLabel>
      <FieldLabel>
        Abstract
        <Textarea value={draft.abstract} onChange={setField('abstract')} rows={4} />
      </FieldLabel>
      <FieldLabel>
        Year
        <Input type="number" value={draft.publicationYear} onChange={setField('publicationYear')} />
      </FieldLabel>
      <FieldLabel>
        Venue
        <Input value={draft.venue} onChange={setField('venue')} />
      </FieldLabel>
      <FieldLabel>
        Publication type
        <Input value={draft.publicationType} onChange={setField('publicationType')} />
      </FieldLabel>
      <FieldLabel>
        DOI
        <Input value={draft.doi} onChange={setField('doi')} />
      </FieldLabel>
      <FieldLabel>
        Publisher URL
        <Input value={draft.publisherUrl} onChange={setField('publisherUrl')} />
      </FieldLabel>
      <FieldLabel>
        Keywords
        <Input value={draft.keywords} onChange={setField('keywords')} />
      </FieldLabel>
      <FieldLabel>
        ISBN
        <Input value={draft.isbn} onChange={setField('isbn')} />
      </FieldLabel>
      <FieldLabel>
        ISSN
        <Input value={draft.issn} onChange={setField('issn')} />
      </FieldLabel>
      <FieldLabel>
        PubMed ID
        <Input value={draft.pubmedId} onChange={setField('pubmedId')} />
      </FieldLabel>
      <FieldLabel>
        arXiv ID
        <Input value={draft.arxivId} onChange={setField('arxivId')} />
      </FieldLabel>
    </>
  )
}
