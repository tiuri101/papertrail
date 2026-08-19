import { useEffect, useRef } from 'react'

import { DoiPill } from '../../components/DoiPill'
import { Button } from '../../components/Button'
import { HighlightedText } from '../../components/HighlightedText'
import { IconArrowRight, IconCheckCircle } from '../../components/icons'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { formatHotkey, loadScreeningHotkeys } from '../../lib/screeningHotkeys'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { fullTextDocumentEndpoint, useFullTextDocument } from '../fulltext/useFullTextDocument'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import { useScreeningDecisionHotkeys } from './useScreeningDecisionHotkeys'
import type { ScreeningQueue } from './useScreeningQueue'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'

export function ScreeningItemCard(queue: ScreeningQueue & { highlightKeywords: string[] }) {
  const { item, answers, setAnswers, outcome, setOutcome, notes, setNotes, criteriaComplete, submit, highlightKeywords } = queue
  const awaitingConfirmation = queue.submitted !== null
  const decisionPending = awaitingConfirmation ? queue.reviseDecision.isPending : submit.isPending
  const isFullTextStage = queue.stage === 'full_text'
  const fullTextDocument = useFullTextDocument(
    queue.projectId,
    isFullTextStage ? (item?.publication.id ?? '') : '',
  )
  const titleRef = useRef<HTMLHeadingElement>(null)
  const visibleItemId = item?.id
  useEffect(() => {
    if (visibleItemId) titleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [visibleItemId])

  useScreeningDecisionHotkeys({
    enabled: Boolean(item),
    setOutcome,
    onSubmit: () => {
      if (decisionPending || !criteriaComplete) return
      if (awaitingConfirmation) queue.confirmDecision()
      else submit.mutate()
    },
  })

  if (!item) return null
  const decisionError = awaitingConfirmation ? queue.reviseDecision.error : submit.error
  const submitHotkey = formatHotkey(loadScreeningHotkeys().submit)
  const abstractContent = item.publication.abstract
    ? <HighlightedText text={item.publication.abstract} keywords={highlightKeywords} />
    : 'No abstract available.'

  return (
    <article className="card">
      <h2 ref={titleRef} className="publication-title"><HighlightedText text={item.publication.title} keywords={highlightKeywords} /></h2>
      <p>{item.publication.authors ?? 'Unknown authors'}</p>
      {item.publication.venue ? <p className="muted">{item.publication.venue}</p> : null}
      {isFullTextStage ? (
        <details className="publication-card__abstract">
          <summary>Abstract</summary>
          <p>{abstractContent}</p>
        </details>
      ) : (
        <p>{abstractContent}</p>
      )}
      <div className="toolbar">
        {isFullTextStage && fullTextDocument.data ? (
          <PdfAvailabilityPill
            available={fullTextDocument.data.available}
            href={`${fullTextDocumentEndpoint(queue.projectId, item.publication.id)}/content`}
            pageCount={fullTextDocument.data.document?.pageCount}
          />
        ) : null}
        <DoiPill doi={item.publication.doi} />
        {isSafeHttpUrl(item.publication.publisherUrl) ? (
          <PublisherLinkPill url={item.publication.publisherUrl} />
        ) : null}
      </div>
      <CriteriaAnswerFields
        key={item.id}
        criteria={item.criteria}
        answers={answers}
        setAnswers={setAnswers}
        outcome={outcome}
        setOutcome={setOutcome}
        notes={notes}
        setNotes={setNotes}
        autoFocusFirstCriterion
      />
      <ScreeningLlmPanel
        projectId={queue.projectId}
        publicationId={item.publication.id}
        itemId={item.id}
        stage={queue.stage as 'title_abstract' | 'full_text'}
        humanDecision={awaitingConfirmation ? outcome : undefined}
        criteriaAnswers={answers}
        criteria={item.criteria}
        setCriteriaAnswers={setAnswers}
      />
      {!criteriaComplete ? (
        <p className="muted">Answer every criterion before {awaitingConfirmation ? 'confirming' : 'submitting'}.</p>
      ) : null}
      {decisionError ? (
        <p className="error" role="alert">{decisionError.message}</p>
      ) : null}
      <div className="toolbar">
        <Button
          type="button"
          variant="primary"
          onClick={() => awaitingConfirmation ? queue.confirmDecision() : submit.mutate()}
          disabled={decisionPending || !criteriaComplete}
        >
          <IconCheckCircle />
          {awaitingConfirmation ? 'Confirm Decision' : 'Submit Decision'}
          {submitHotkey ? <kbd className="submit-button__hotkey" aria-hidden="true">{submitHotkey}</kbd> : null}
        </Button>
        {!awaitingConfirmation ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => queue.skip.mutate()}
            disabled={queue.skip.isPending || submit.isPending}
          >
            <IconArrowRight />
            Skip for now
          </Button>
        ) : null}
      </div>
      {queue.skip.error ? <p className="error" role="alert">{queue.skip.error.message}</p> : null}
    </article>
  )
}
