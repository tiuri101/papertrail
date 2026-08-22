import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { getCsrfToken } from '../auth/session'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconSparkle } from '../../components/icons'
import { FileDropZone } from '../imports/FileDropZone'
import { applyBibtexFields, PublicationDraft } from './publicationFieldsData'

interface PreviewResponse {
  filename: string
  recordCount: number
  normalizedPreview: Record<string, unknown>[]
}

interface PrefillResult {
  filename: string
  recordCount: number
  fields: Record<string, unknown>
}

export function BibtexPrefillPanel({
  projectId,
  onPrefill,
}: {
  projectId: string
  onPrefill: (updater: (draft: PublicationDraft) => PublicationDraft) => void
}) {
  const [bibFile, setBibFile] = useState<File[]>([])
  const [bibText, setBibText] = useState('')

  const prefill = useMutation({
    mutationFn: async (): Promise<PrefillResult> => {
      const source = bibFile[0] ?? new File([bibText], 'pasted.bib', { type: 'text/plain' })
      const form = new FormData()
      form.append('file', source)
      const response = await fetch(`/api/v1/projects/${projectId}/imports/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() ?? '' },
        body: form,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message ?? 'Could not parse the BibTeX')
      }
      const result = (await response.json()) as PreviewResponse
      return {
        filename: result.filename,
        recordCount: result.recordCount,
        fields: result.normalizedPreview[0] ?? {},
      }
    },
    onSuccess: ({ fields }) => {
      onPrefill((draft) => applyBibtexFields(draft, fields))
      setBibFile([])
      setBibText('')
    },
  })

  return (
    <CollapsibleSection
      id="section-bibtex-prefill"
      title="Prefill from BibTeX"
      defaultExpanded={false}
    >
      <p className="muted">
        Upload a .bib file or paste a BibTeX entry to fill in the fields below. Only the first
        entry is used — for adding many publications at once, use Import instead.
      </p>
      {prefill.error ? <p className="error" role="alert">{prefill.error.message}</p> : null}
      <FileDropZone
        id="bibtex-prefill-file"
        label="BibTeX file"
        hint=".bib or .bibtex file"
        accept=".bib,.bibtex,text/x-bibtex"
        files={bibFile}
        onChange={(files) => {
          setBibFile(files)
          if (files.length) setBibText('')
        }}
        disabled={prefill.isPending}
      />
      <label>
        Or paste BibTeX
        <textarea
          value={bibText}
          onChange={(event) => {
            setBibText(event.target.value)
            if (event.target.value) setBibFile([])
          }}
          rows={4}
          disabled={prefill.isPending}
          placeholder="@article{..."
        />
      </label>
      <div className="toolbar">
        <Button
          type="button"
          disabled={(!bibFile.length && !bibText.trim()) || prefill.isPending}
          onClick={() => prefill.mutate()}
        >
          <IconSparkle />
          {prefill.isPending ? 'Parsing…' : 'Prefill form'}
        </Button>
      </div>
      {prefill.isSuccess ? (
        <p>
          Prefilled from {prefill.data.filename}
          {prefill.data.recordCount > 1
            ? ` (${prefill.data.recordCount} entries found; used the first)`
            : ''}
          .
        </p>
      ) : null}
    </CollapsibleSection>
  )
}
