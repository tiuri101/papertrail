import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'

function toLines(keywords: string[]): string {
  return keywords.join('\n')
}

function toKeywords(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const AUTOSAVE_DELAY_MS = 800

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
    mutationFn: (nextKeywords: string[]) => apiRequest<{ keywords: string[] }>(
      `/api/v1/projects/${projectId}/highlight-keywords`,
      { method: 'PUT', body: JSON.stringify({ keywords: nextKeywords }) },
    ),
    onSuccess: (result) => {
      queryClient.setQueryData(['highlight-keywords', projectId], result)
    },
  })

  const saveRef = useRef(save.mutate)
  saveRef.current = save.mutate

  useEffect(() => {
    if (!keywords.data) return
    if (draft === toLines(keywords.data.keywords)) return
    const timer = setTimeout(() => saveRef.current(toKeywords(draft)), AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [draft, keywords.data])

  return (
    <CollapsibleSection id="section-highlighted-keywords" title="Highlighted Keywords">
      <p className="muted">Keywords entered here are highlighted wherever reviewers see publication titles and abstracts, one keyword per line. Changes save automatically.</p>
      {keywords.error ? <p className="error" role="alert">{keywords.error.message}</p> : null}
      <label>
        Keywords
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
        />
      </label>
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}
