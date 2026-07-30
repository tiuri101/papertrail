import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { getCsrfToken } from '../auth/session'

interface ImportResult { jobId: string }

export function ImportPage() {
  const { projectId = '' } = useParams()
  const [file, setFile] = useState<File | null>(null)
  const upload = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      if (!file) throw new Error('Choose a file')
      const form = new FormData()
      form.append('file', file)
      const response = await fetch(`/api/v1/projects/${projectId}/imports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() ?? '' },
        body: form,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message ?? 'Import failed')
      }
      return response.json() as Promise<ImportResult>
    },
  })

  return (
    <main className="page">
      <h1>Import records</h1>
      <label>Bibliographic export
        <input type="file" accept=".csv,.tsv,.xlsx,.ris,.bib,.bibtex" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </label>
      <button type="button" onClick={() => upload.mutate()} disabled={!file || upload.isPending}>Upload</button>
      {upload.error ? <p className="error" role="alert">{upload.error.message}</p> : null}
      {upload.data ? <p>Import queued: {upload.data.jobId}</p> : null}
    </main>
  )
}
