import { useMutation } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { IconArrowRight, IconCheckCircle } from '../../components/icons'
import { isAnswered } from '../forms/answers'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'
import { useFullTextDocument } from '../fulltext/useFullTextDocument'
import type { PublicationSummary } from '../publications/types'
import { ReviewPublicationHeader } from '../reviews/ReviewPublicationHeader'
import { ReviewQueueEmptyState } from '../reviews/ReviewQueueEmptyState'
import { useReviewWorkQueue } from '../reviews/useReviewWorkQueue'
import { Button } from '../../components/Button'
import { Form } from '../../components/Form'

interface WorkItem {
  id: string
  publicationId: string
  status: string
  draft: Record<string, unknown>
  publication: PublicationSummary
  fields: DynamicFormField[]
  currentResponse: QualityResponse | null
}

interface QualityResponse {
  id: string
  answers: Record<string, unknown>
  totalScore: number | null
  version: number
}

export interface QualityWorkspaceProps {
  projectId: string
  itemId?: string
  /** 'page' renders its own card chrome (title, links); 'inline' is embedded in a caller-provided card. */
  variant?: 'page' | 'inline'
  onSubmitted?: (info: { id: string; publicationTitle: string; totalScore: number | null }) => void
  onCancel?: () => void
}

export function QualityWorkspace({
  projectId,
  itemId,
  variant = 'page',
  onSubmitted,
  onCancel,
}: QualityWorkspaceProps) {
  const {
    item,
    answers,
    setAnswers,
    queueEmpty,
    loadingNext,
    nextError,
    completedResponse,
    setCompletedResponse,
    skip,
    resetAndFetchNext,
    titleRef,
  } = useReviewWorkQueue<WorkItem, QualityResponse>({
    baseUrl: `/api/v1/projects/${projectId}/quality`,
    itemId,
    variant,
    loadErrorFallback: 'Failed to load the next assessment',
  })
  const fullTextDocument = useFullTextDocument(projectId, item?.publicationId ?? '')

  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No assessment is open')
      return apiRequest<QualityResponse>(
        `/api/v1/projects/${projectId}/quality/${item.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ answers }),
        },
      )
    },
    onSuccess: (response) => {
      if (item) {
        onSubmitted?.({
          id: item.id,
          publicationTitle: item.publication.title,
          totalScore: response.totalScore,
        })
      }
      if (itemId) {
        setCompletedResponse(response)
        return
      }
      resetAndFetchNext()
    },
  })

  const missingRequired = item?.fields.some(
    (field) => field.required && !isAnswered(answers[field.stableKey]),
  ) ?? false

  if (!item) {
    return (
      <ReviewQueueEmptyState
        projectId={projectId}
        loadingNext={loadingNext}
        loadingMessage="Loading the next assessment…"
        queueEmpty={queueEmpty}
        completedMessage="You have completed all of your assigned assessment work."
        nextError={nextError}
      />
    )
  }

  const body = (
    <>
      {variant !== 'inline' ? (
        <ReviewPublicationHeader
          titleRef={titleRef}
          projectId={projectId}
          publicationId={item.publicationId}
          publication={item.publication}
          fullTextDocument={fullTextDocument}
        />
      ) : null}
      <Form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
        <DynamicForm
          fields={item.fields}
          value={answers}
          onChange={(key, value) => setAnswers((current) => ({ ...current, [key]: value }))}
        />
        {missingRequired ? (
          <p className="muted">Answer every required field before submitting.</p>
        ) : null}
        {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
        {skip.error ? <p className="error" role="alert">{skip.error.message}</p> : null}
        <div className="toolbar">
          <Button type="submit" disabled={submit.isPending || skip.isPending || missingRequired}>
            <IconCheckCircle />
            {completedResponse ? 'Save corrected assessment' : 'Submit Assessment'}
          </Button>
          {!itemId ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => skip.mutate()}
              disabled={submit.isPending || skip.isPending}
            >
              <IconArrowRight />
              Skip for now
            </Button>
          ) : null}
          {variant === 'inline' && onCancel ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              disabled={submit.isPending}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </Form>
    </>
  )

  return variant === 'inline' ? body : <article className="card">{body}</article>
}
