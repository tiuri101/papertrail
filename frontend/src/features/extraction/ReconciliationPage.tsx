import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Page } from '../../components/Page'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { Input } from '../../components/Input'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { Textarea } from '../../components/Textarea'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { useCanReconcileExtractionState } from '../../hooks/useCanManageProject'
import { fullTextDocumentEndpoint, useFullTextDocument } from '../fulltext/useFullTextDocument'
import { StageEyebrow } from '../projects/StageEyebrow'

interface QueuePublication {
  id: string
  title: string
  authors: string | null
  doi: string | null
  publisherUrl: string | null
}

interface QueueItem {
  publication: QueuePublication
}

interface FieldMeta {
  stableKey: string
  label: string
  fieldType: string
  required: boolean
  position: number
  options: string[]
}

interface FieldComparison {
  stableKey: string
  fieldType: string
  valueA: unknown
  valueB: unknown
  agree: boolean
}

interface ReconciliationDetail {
  publication: QueuePublication
  fullTextAvailable: boolean
  fields: FieldMeta[]
  comparisons: FieldComparison[]
}

type Choice = 'response_a' | 'response_b' | 'manual'

function formatValue(value: unknown, fieldType: string): string {
  if (value === null || value === undefined || value === '') return '(no answer)'
  if (fieldType === 'checkbox') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(no answer)'
  return String(value)
}

export function ReconciliationPage() {
  const { projectId = '' } = useParams()
  const { canReconcile, isLoading: canReconcileLoading } = useCanReconcileExtractionState(projectId)
  const queryClient = useQueryClient()
  const [expandedPublicationId, setExpandedPublicationId] = useState<string | null>(null)

  const queue = useQuery({
    queryKey: ['extraction-reconciliation', projectId],
    queryFn: () => apiRequest<QueueItem[]>(`/api/v1/projects/${projectId}/extraction/reconciliation`),
    enabled: Boolean(projectId) && canReconcile,
  })

  if (canReconcileLoading) {
    return <Page><p>Loading…</p></Page>
  }
  if (!canReconcile) {
    return (
      <Page>
        <StageEyebrow stage="extraction_quality" />
        <h1>Extraction Conflicts</h1>
        <p className="text-danger" role="alert">
          Only project managers or adjudicators can reconcile extraction disagreements.
        </p>
      </Page>
    )
  }

  const list = queue.data ?? []

  return (
    <Page>
      <StageEyebrow stage="extraction_quality" />
      <h1>Extraction Conflicts</h1>
      <p className="text-text-muted">
        Publications where two independent extractors disagreed on at least one field. Resolve
        each disagreeing field to produce the authoritative extraction result.
      </p>
      {queue.error ? <p className="text-danger" role="alert">{queue.error.message}</p> : null}
      <CountPill count={list.length}>
        publication{list.length === 1 ? '' : 's'} awaiting reconciliation
      </CountPill>
      <ul className="m-0 grid list-none gap-5 p-0" aria-label="Publications awaiting reconciliation">
        {list.map((item) => (
          <Card as="li" key={item.publication.id}>
            <h2>{item.publication.title}</h2>
            <p className="text-text-muted">{item.publication.authors ?? 'Unknown authors'}</p>
            <div className="flex flex-wrap items-center gap-3">
              <DoiPill doi={item.publication.doi} />
              {isSafeHttpUrl(item.publication.publisherUrl) ? (
                <PublisherLinkPill url={item.publication.publisherUrl} />
              ) : null}
            </div>
            {expandedPublicationId === item.publication.id ? (
              <ReconciliationForm
                projectId={projectId}
                publicationId={item.publication.id}
                onDone={() => {
                  setExpandedPublicationId(null)
                  queryClient.invalidateQueries({ queryKey: ['extraction-reconciliation', projectId] })
                }}
                onCancel={() => setExpandedPublicationId(null)}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={() => setExpandedPublicationId(item.publication.id)}>
                  Reconcile
                </Button>
              </div>
            )}
          </Card>
        ))}
      </ul>
    </Page>
  )
}

function ReconciliationForm({ projectId, publicationId, onDone, onCancel }: {
  projectId: string
  publicationId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [choices, setChoices] = useState<Record<string, { choice: Choice; value?: unknown }>>({})
  const [note, setNote] = useState('')
  const fullTextDocument = useFullTextDocument(projectId, publicationId)

  const detail = useQuery({
    queryKey: ['extraction-reconciliation-detail', projectId, publicationId],
    queryFn: () => apiRequest<ReconciliationDetail>(
      `/api/v1/projects/${projectId}/extraction/reconciliation/${publicationId}`,
    ),
  })

  const submit = useMutation({
    mutationFn: () => apiRequest(
      `/api/v1/projects/${projectId}/extraction/reconciliation/${publicationId}`,
      {
        method: 'POST',
        body: JSON.stringify({ fieldChoices: choices, note }),
      },
    ),
    onSuccess: onDone,
  })

  if (detail.isLoading) return <p>Loading comparison…</p>
  if (detail.error || !detail.data) {
    return <p className="text-danger" role="alert">{detail.error?.message ?? 'Could not load the comparison.'}</p>
  }

  const fieldsByKey = new Map(detail.data.fields.map((field) => [field.stableKey, field]))
  const disagreeing = detail.data.comparisons.filter((comparison) => !comparison.agree)
  const missingChoice = disagreeing.some((comparison) => !choices[comparison.stableKey])

  return (
    <div className="border-t border-border pt-5">
      <div className="flex flex-wrap items-center gap-3">
        {fullTextDocument.data ? (
          <PdfAvailabilityPill
            available={fullTextDocument.data.available}
            href={`${fullTextDocumentEndpoint(projectId, publicationId)}/content`}
            pageCount={fullTextDocument.data.document?.pageCount}
          />
        ) : null}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Reviewer A</th>
            <th scope="col">Reviewer B</th>
            <th scope="col">Resolution</th>
          </tr>
        </thead>
        <tbody>
          {detail.data.comparisons.map((comparison) => {
            const field = fieldsByKey.get(comparison.stableKey)
            const label = field?.label ?? comparison.stableKey
            if (comparison.agree) {
              return (
                <tr key={comparison.stableKey} className="bg-success-container/40">
                  <th scope="row">{label}</th>
                  <td colSpan={2}>{formatValue(comparison.valueA, comparison.fieldType)}</td>
                  <td>Agreed</td>
                </tr>
              )
            }
            const current = choices[comparison.stableKey]
            return (
              <tr key={comparison.stableKey} className="bg-warning-container/40">
                <th scope="row">{label}</th>
                <td>{formatValue(comparison.valueA, comparison.fieldType)}</td>
                <td>{formatValue(comparison.valueB, comparison.fieldType)}</td>
                <td>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant={current?.choice === 'response_a' ? 'primary' : 'secondary'}
                      onClick={() => setChoices((prev) => ({ ...prev, [comparison.stableKey]: { choice: 'response_a' } }))}
                    >
                      Use A
                    </Button>
                    <Button
                      type="button"
                      variant={current?.choice === 'response_b' ? 'primary' : 'secondary'}
                      onClick={() => setChoices((prev) => ({ ...prev, [comparison.stableKey]: { choice: 'response_b' } }))}
                    >
                      Use B
                    </Button>
                    <Button
                      type="button"
                      variant={current?.choice === 'manual' ? 'primary' : 'secondary'}
                      onClick={() => setChoices((prev) => ({ ...prev, [comparison.stableKey]: { choice: 'manual', value: prev[comparison.stableKey]?.value ?? '' } }))}
                    >
                      Manual
                    </Button>
                  </div>
                  {current?.choice === 'manual' ? (
                    <label>
                      Manual value
                      <Input
                        value={typeof current.value === 'string' ? current.value : String(current.value ?? '')}
                        onChange={(event) => setChoices((prev) => ({
                          ...prev,
                          [comparison.stableKey]: { choice: 'manual', value: event.target.value },
                        }))}
                      />
                    </label>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <label>
        Reconciliation note
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} required />
      </label>
      {submit.error ? <p className="text-danger" role="alert">{submit.error.message}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          onClick={() => submit.mutate()}
          disabled={submit.isPending || missingChoice || !note.trim()}
        >
          Submit Reconciliation
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submit.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
