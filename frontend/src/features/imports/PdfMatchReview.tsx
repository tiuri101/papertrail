import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'

interface MatchItem {
  id: string
  originalFilename: string
  fileSize: number | null
  detectedDoi: string | null
  detectedTitle: string | null
  detectedAuthors: string | null
  detectedYear: number | null
  status: string
  candidates: Array<{ publicationId: string; title: string; reason: string }>
  matchedPublicationId: string | null
  errorMessage: string | null
}

interface MatchPublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  hasPdf: boolean
}

export interface PdfSummary {
  total: number
  matched: number
  ambiguous: number
  unmatched: number
  duplicate: number
  conflict_existing_pdf: number
  invalid: number
  skipped: number
}

interface MatchReview {
  summary: PdfSummary
  items: MatchItem[]
  publications: MatchPublication[]
}

const unresolved = new Set(['ambiguous', 'unmatched', 'conflict_existing_pdf'])

export function PdfMatchReview({ projectId, importBatchId }: {
  projectId: string
  importBatchId: string
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('needs_review')
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [searches, setSearches] = useState<Record<string, string>>({})
  const queryKey = ['pdf-matches', projectId, importBatchId]
  const endpoint = `/api/v1/projects/${projectId}/imports/${importBatchId}/pdf-matches`
  const review = useQuery({ queryKey, queryFn: () => apiRequest<MatchReview>(endpoint) })
  const resolve = useMutation({
    mutationFn: ({ itemId, publicationId, action }: {
      itemId: string
      publicationId: string | null
      action: string
    }) => apiRequest(`${endpoint}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ itemId, publicationId, action }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const items = review.data?.items.filter((item) => (
    filter === 'all' ? true
      : filter === 'needs_review' ? unresolved.has(item.status)
        : item.status === filter
  )) ?? []

  return (
    <section className="card">
      <h2>Review PDF matches</h2>
      {review.error ? <p className="error" role="alert">{review.error.message}</p> : null}
      <label>
        PDF match filter
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="needs_review">Needs review</option>
          <option value="unmatched">Unmatched</option>
          <option value="conflict_existing_pdf">Existing-PDF conflicts</option>
          <option value="all">All</option>
        </select>
      </label>
      <div className="card-list">
        {items.map((item) => {
          const selected = selections[item.id]
            ?? item.matchedPublicationId
            ?? item.candidates[0]?.publicationId
            ?? ''
          const isConflict = item.status === 'conflict_existing_pdf'
          const publicationSearch = (searches[item.id] ?? '').trim().toLocaleLowerCase()
          const publicationOptions = review.data?.publications.filter((publication) => (
            !publicationSearch
            || `${publication.title} ${publication.authors ?? ''}`
              .toLocaleLowerCase()
              .includes(publicationSearch)
          )) ?? []
          return (
            <article className="nested-card" key={item.id}>
              <h3>{item.originalFilename}</h3>
              <p className="muted">
                {item.detectedTitle ?? 'No title detected'}
                {item.detectedAuthors ? ` · ${item.detectedAuthors}` : ''}
                {item.detectedYear ? ` · ${item.detectedYear}` : ''}
                {item.detectedDoi ? ` · DOI ${item.detectedDoi}` : ''}
              </p>
              {item.errorMessage ? <p className="error">{item.errorMessage}</p> : null}
              {unresolved.has(item.status) ? (
                <>
                  <label>
                    Search publications for {item.originalFilename}
                    <input
                      type="search"
                      value={searches[item.id] ?? ''}
                      onChange={(event) => setSearches((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))}
                    />
                  </label>
                  <label>
                    Publication match for {item.originalFilename}
                    <select
                      value={selected}
                      onChange={(event) => setSelections((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))}
                    >
                      <option value="">Choose a publication</option>
                      {publicationOptions.map((publication) => (
                        <option value={publication.id} key={publication.id}>
                          {publication.title}
                          {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
                          {publication.hasPdf ? ' · PDF attached' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="toolbar">
                    <button
                      type="button"
                      disabled={!selected || resolve.isPending || isConflict}
                      onClick={() => resolve.mutate({ itemId: item.id, publicationId: selected, action: 'attach' })}
                    >
                      Attach
                    </button>
                    {isConflict ? (
                      <button
                        type="button"
                        disabled={!selected || resolve.isPending}
                        onClick={() => {
                          if (window.confirm('Replace the existing PDF and retain it in history?')) {
                            resolve.mutate({ itemId: item.id, publicationId: selected, action: 'replace' })
                          }
                        }}
                      >
                        Replace existing
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({
                        itemId: item.id,
                        publicationId: null,
                        action: isConflict ? 'keep_existing' : 'skip',
                      })}
                    >
                      {isConflict ? 'Keep existing' : 'Skip'}
                    </button>
                  </div>
                </>
              ) : <p>Status: {item.status.replaceAll('_', ' ')}</p>}
            </article>
          )
        })}
      </div>
      {items.length === 0 && review.data ? <p className="muted">No PDF matches in this view.</p> : null}
    </section>
  )
}
