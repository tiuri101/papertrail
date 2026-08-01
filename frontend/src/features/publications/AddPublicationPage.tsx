import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import {
  emptyPublicationDraft,
  PublicationDraft,
  PublicationFieldInputs,
  toPayload,
} from './publicationFields'

export function AddPublicationPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<PublicationDraft>(emptyPublicationDraft)

  const setField = (field: keyof PublicationDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }))

  const create = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications`, {
      method: 'POST',
      body: JSON.stringify(toPayload(draft)),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
      setDraft(emptyPublicationDraft)
    },
  })

  return (
    <main className="page">
      <h1>Add a Publication</h1>
      <section className="card">
        <p className="muted">Add a single record by hand, without importing an export file from a database.</p>
        <form onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
          <PublicationFieldInputs draft={draft} setField={setField} />
          {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
          {create.isSuccess ? <p>Publication added.</p> : null}
          <button type="submit" disabled={create.isPending || !draft.title.trim()}>Add Publication</button>
        </form>
      </section>
    </main>
  )
}
