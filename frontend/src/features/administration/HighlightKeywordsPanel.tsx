import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button, IconButton } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { HighlightedText } from '../../components/HighlightedText'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { IconHighlighter, IconPlus, IconTrash } from '../../components/icons'
import { FieldLabel } from '../../components/FieldLabel'
import { FieldLegend } from '../../components/FieldLegend'

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
    <CollapsibleSection id="section-highlighted-keywords" title="Highlighted Keywords" icon={<IconHighlighter />}>
      <InfoBox icon={<IconHighlighter />}>
        <p>Keywords entered here are highlighted in publication titles and abstracts.</p>
      </InfoBox>
      {keywords.error ? <p className="text-danger" role="alert">{keywords.error.message}</p> : null}
      {keywords.isPending ? <p className="text-text">Loading keywords…</p> : null}
      {!keywords.isPending && draft.length === 0 ? (
        <p className="my-4 w-fit rounded-sm border border-dashed border-border-strong p-4 text-text-muted">No highlighted keywords yet.</p>
      ) : null}
      {draft.length > 0 ? (
        <fieldset className="grid gap-3">
          <FieldLegend>Keywords</FieldLegend>
          {draft.map((keyword, index) => (
            <div className="grid grid-cols-[minmax(0,1fr)_40px] items-center gap-3 min-[681px]:grid-cols-[minmax(12rem,1fr)_minmax(10rem,0.7fr)_40px]" key={index}>
              <label className="min-w-0">
                <span className="sr-only">Keyword {index + 1}</span>
                <Input
                  value={keyword}
                  onChange={(event) => editKeyword(index, event.target.value)}
                />
              </label>
              <span className="col-span-full row-start-2 min-w-0 truncate min-[681px]:col-span-1 min-[681px]:row-start-auto [&_mark]:inline-block [&_mark]:max-w-full [&_mark]:truncate [&_mark]:align-middle" aria-label={`Preview for keyword ${index + 1}`}>
                {keyword.trim() ? (
                  <HighlightedText text={keyword.trim()} keywords={[keyword.trim()]} />
                ) : (
                  <span className="text-text">Enter a keyword</span>
                )}
              </span>
              <IconButton
                type="button"
                variant="destructive"
                aria-label={`Delete keyword ${index + 1}`}
                onClick={() => deleteKeyword(index)}
              >
                <IconTrash />
              </IconButton>
            </div>
          ))}
        </fieldset>
      ) : null}
      <form
        className="mt-5 grid grid-cols-1 gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          addKeyword()
        }}
      >
        <FieldLabel htmlFor={newKeywordId}>Add a keyword</FieldLabel>
        <div className="flex flex-col items-stretch gap-3 min-[681px]:flex-row min-[681px]:items-center">
          <Input
            id={newKeywordId}
            value={newKeyword}
            onChange={(event) => setNewKeyword(event.target.value)}
            className="max-w-lg"
            placeholder="Enter a word or phrase"
          />
          <Button className="w-full shrink-0 min-[681px]:w-auto" type="submit" disabled={!newKeyword.trim()}>
            <IconPlus />
            Add keyword
          </Button>
        </div>
      </form>
      {save.error ? <p className="text-danger" role="alert">{save.error.message}</p> : null}
      {save.isPending || save.isSuccess ? <p className="text-text" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p> : null}
    </CollapsibleSection>
  )
}
