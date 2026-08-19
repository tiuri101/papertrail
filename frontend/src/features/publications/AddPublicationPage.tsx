import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { getCsrfToken } from '../auth/session'
import { IconPlus } from '../../components/icons'
import { BibtexPrefillPanel } from './BibtexPrefillPanel'
import { FileDropZone } from '../imports/FileDropZone'
import { PublicationFieldInputs } from './publicationFields'
import { emptyPublicationDraft, PublicationDraft, toPayload } from './publicationFieldsData'

interface CreatedPublication {
  id: string
}

export function AddPublicationForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<PublicationDraft>(emptyPublicationDraft)
  const [pdfFile, setPdfFile] = useState<File[]>([])

  const setField = (field: keyof PublicationDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }))

  const attachPdf = useMutation({
    mutationFn: async ({ publicationId, file }: { publicationId: string; file: File }) => {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch(
        `/api/v1/projects/${projectId}/publications/${publicationId}/full-text`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': getCsrfToken() ?? '' },
          body: form,
        },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message ?? 'Could not attach the PDF')
      }
      return response.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
      setPdfFile([])
    },
  })

  const create = useMutation({
    mutationFn: () => apiRequest<CreatedPublication>(`/api/v1/projects/${projectId}/publications`, {
      method: 'POST',
      body: JSON.stringify(toPayload(draft)),
    }),
    onSuccess: (publication) => {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
      setDraft(emptyPublicationDraft)
      if (pdfFile[0]) {
        attachPdf.mutate({ publicationId: publication.id, file: pdfFile[0] })
      }
    },
  })

  return (
    <>
      <BibtexPrefillPanel projectId={projectId} onPrefill={setDraft} />
      <section className="card">
        <p className="muted">Add a single record by hand, without importing an export file from a database.</p>
        <form onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
          <PublicationFieldInputs draft={draft} setField={setField} />
          <FileDropZone
            id="add-publication-pdf"
            label="PDF"
            hint="Attach the paper's PDF (optional)"
            accept="application/pdf,.pdf"
            files={pdfFile}
            onChange={setPdfFile}
            disabled={create.isPending}
          />
          {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
          {attachPdf.error ? (
            <p className="error" role="alert">
              Publication added, but the PDF could not be attached: {attachPdf.error.message}
            </p>
          ) : null}
          {create.isSuccess && !attachPdf.isPending && !attachPdf.error ? <p>Publication added.</p> : null}
          <button type="submit" disabled={create.isPending || attachPdf.isPending || !draft.title.trim()}>
            <IconPlus />
            {attachPdf.isPending ? 'Attaching PDF…' : 'Add Publication'}
          </button>
        </form>
      </section>
    </>
  )
}

export function AddPublicationPage() {
  const { projectId = '' } = useParams()
  return (
    <main className="page add-publication-page">
      <h1>Add a Publication</h1>
      <AddPublicationForm projectId={projectId} />
    </main>
  )
}
