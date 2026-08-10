import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { HighlightedText } from '../../components/HighlightedText'
import { IconPlus, IconTrash } from '../../components/icons'

function cleanKeywords(keywords: string[]): string[] {
  return keywords.map((keyword) => keyword.trim()).filter(Boolean)
}

const AUTOSAVE_DELAY_MS = 800

export function HighlightKeywordsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const newKeywordId = useId()
  const keywords = useQuery({
    queryKey: ['highlight-keywords', projectId],
    queryFn: () => apiRequest<{ keywords: string[] }>(
      `/api/v1/projects/${projectId}/highlight-keywords`,
    ),
    enabled: Boolean(projectId),
  })
  const [draft, setDraft] = useState<string[]>([])
  const [newKeyword, setNewKeyword] = useState('')

  useEffect(() => {
    if (keywords.data) setDraft(keywords.data.keywords)
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
    const cleanedDraft = cleanKeywords(draft)
    if (JSON.stringify(cleanedDraft) === JSON.stringify(keywords.data.keywords)) return
    const timer = setTimeout(() => saveRef.current(cleanedDraft), AUTOSAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [draft, keywords.data])

  function editKeyword(index: number, value: string) {
    setDraft((current) => current.map((keyword, keywordIndex) => (
      keywordIndex === index ? value : keyword
    )))
  }

  function deleteKeyword(index: number) {
    setDraft((current) => current.filter((_, keywordIndex) => keywordIndex !== index))
  }

  function addKeyword() {
    const cleaned = newKeyword.trim()
    if (!cleaned) return
    setDraft((current) => [...current, cleaned])
    setNewKeyword('')
  }

  return (
    <CollapsibleSection id="section-highlighted-keywords" title="Highlighted Keywords">
      <p className="muted">Keywords entered here are highlighted wherever reviewers see publication titles and abstracts. The preview shows the color reviewers will see. Changes save automatically.</p>
      {keywords.error ? <p className="error" role="alert">{keywords.error.message}</p> : null}
      {keywords.isPending ? <p className="muted">Loading keywords…</p> : null}
      {!keywords.isPending && draft.length === 0 ? (
        <p className="keyword-editor__empty">No highlighted keywords yet.</p>
      ) : null}
      {draft.length > 0 ? (
        <fieldset className="keyword-editor__list">
          <legend>Keywords</legend>
          {draft.map((keyword, index) => (
            <div className="keyword-editor__row" key={index}>
              <label className="keyword-editor__input">
                <span className="visually-hidden">Keyword {index + 1}</span>
                <input
                  value={keyword}
                  onChange={(event) => editKeyword(index, event.target.value)}
                />
              </label>
              <span className="keyword-editor__preview" aria-label={`Preview for keyword ${index + 1}`}>
                {keyword.trim() ? (
                  <HighlightedText text={keyword.trim()} keywords={[keyword.trim()]} />
                ) : (
                  <span className="muted">Enter a keyword</span>
                )}
              </span>
              <button
                type="button"
                className="icon-button keyword-editor__delete"
                aria-label={`Delete keyword ${index + 1}`}
                onClick={() => deleteKeyword(index)}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </fieldset>
      ) : null}
      <form
        className="keyword-editor__add"
        onSubmit={(event) => {
          event.preventDefault()
          addKeyword()
        }}
      >
        <label htmlFor={newKeywordId}>Add a keyword</label>
        <div className="keyword-editor__add-controls">
          <input
            id={newKeywordId}
            value={newKeyword}
            onChange={(event) => setNewKeyword(event.target.value)}
            placeholder="Enter a word or phrase"
          />
          <button type="submit" disabled={!newKeyword.trim()}>
            <IconPlus />
            Add keyword
          </button>
        </div>
      </form>
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}
