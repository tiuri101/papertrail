import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface WorkItem {
  id: string
  publicationId: string
  draft: Record<string, unknown>
}

export function ExtractionPage() {
  const { projectId = '' } = useParams()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState('{}')
  const next = useMutation({
    mutationFn: () => apiRequest<WorkItem | null>(
      `/api/v1/projects/${projectId}/extraction/next`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      setItem(result)
      setAnswers(JSON.stringify(result?.draft ?? {}, null, 2))
    },
  })
  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No extraction is open')
      return apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ answers: JSON.parse(answers) }),
        },
      )
    },
    onSuccess: () => {
      setItem(null)
      setAnswers('{}')
    },
  })

  return (
    <main className="page">
      <h1>Data extraction</h1>
      {!item ? (
        <>
          <button
            type="button"
            onClick={() => next.mutate()}
            disabled={next.isPending}
          >
            Get next extraction
          </button>
          {next.error ? <p className="error" role="alert">{next.error.message}</p> : null}
        </>
      ) : (
        <section className="card">
          <p>Publication: {item.publicationId}</p>
          <label>
            Structured answers (JSON)
            <textarea
              rows={16}
              value={answers}
              onChange={(event) => setAnswers(event.target.value)}
            />
          </label>
          {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
          <button
            type="button"
            onClick={() => submit.mutate()}
            disabled={submit.isPending}
          >
            Submit extraction
          </button>
        </section>
      )}
    </main>
  )
}
