import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'

function toLines(keywords: string[]): string {
  return keywords.join('\n')
}

function toKeywords(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function HighlightKeywordsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const keywords = useQuery({
    queryKey: ['highlight-keywords', projectId],
    queryFn: () => apiRequest<{ keywords: string[] }>(
      `/api/v1/projects/${projectId}/highlight-keywords`,
    ),
    enabled: Boolean(projectId),
  })
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (keywords.data) setDraft(toLines(keywords.data.keywords))
  }, [keywords.data])

  const save = useMutation({
    mutationFn: () => apiRequest<{ keywords: string[] }>(
      `/api/v1/projects/${projectId}/highlight-keywords`,
      { method: 'PUT', body: JSON.stringify({ keywords: toKeywords(draft) }) },
    ),
    onSuccess: (result) => {
      queryClient.setQueryData(['highlight-keywords', projectId], result)
    },
  })

  return (
    <section className="card">
      <h2>Highlighted keywords</h2>
      <p className="muted">Keywords entered here are highlighted wherever reviewers see publication titles and abstracts, one keyword per line.</p>
      {keywords.error ? <p className="error" role="alert">{keywords.error.message}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <label>
          Keywords
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
          />
        </label>
        {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
        {save.isSuccess ? <p>Keywords saved.</p> : null}
        <button type="submit" disabled={save.isPending}>Save keywords</button>
      </form>
    </section>
  )
}
