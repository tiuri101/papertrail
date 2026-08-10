import { HighlightedText } from '../../components/HighlightedText'
import { IconArrowRight, IconCheckCircle } from '../../components/icons'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { ScreeningQueue } from './useScreeningQueue'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'

export function ScreeningItemCard(queue: ScreeningQueue & { highlightKeywords: string[] }) {
  const { item, answers, setAnswers, outcome, setOutcome, notes, setNotes, criteriaComplete, submit, highlightKeywords } = queue
  if (!item) return null
  const awaitingConfirmation = queue.submitted !== null
  const decisionError = awaitingConfirmation ? queue.reviseDecision.error : submit.error
  const decisionPending = awaitingConfirmation ? queue.reviseDecision.isPending : submit.isPending

  return (
    <article className="card">
      <h2><HighlightedText text={item.publication.title} keywords={highlightKeywords} /></h2>
      <p>{item.publication.authors ?? 'Unknown authors'}</p>
      {item.publication.venue ? <p className="muted">{item.publication.venue}</p> : null}
      <p>
        {item.publication.abstract
          ? <HighlightedText text={item.publication.abstract} keywords={highlightKeywords} />
          : 'No abstract available.'}
      </p>
      <div className="toolbar">
        {item.publication.doi ? (
          <a
            href={`https://doi.org/${item.publication.doi}`}
            target="_blank"
            rel="noreferrer"
          >
            Open DOI
          </a>
        ) : null}
        {isSafeHttpUrl(item.publication.publisherUrl) ? (
          <a
            href={item.publication.publisherUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open publisher page
          </a>
        ) : null}
      </div>
      <CriteriaAnswerFields
        criteria={item.criteria}
        answers={answers}
        setAnswers={setAnswers}
        outcome={outcome}
        setOutcome={setOutcome}
        notes={notes}
        setNotes={setNotes}
      />
      <ScreeningLlmPanel
        projectId={queue.projectId}
        publicationId={item.publication.id}
        itemId={item.id}
        stage={queue.stage as 'title_abstract' | 'full_text'}
        humanDecision={awaitingConfirmation ? outcome : undefined}
        criteriaAnswers={answers}
      />
      {!criteriaComplete ? (
        <p className="muted">Answer every criterion before {awaitingConfirmation ? 'confirming' : 'submitting'}.</p>
      ) : null}
      {decisionError ? (
        <p className="error" role="alert">{decisionError.message}</p>
      ) : null}
      <div className="toolbar">
        <button
          type="button"
          onClick={() => awaitingConfirmation ? queue.confirmDecision() : submit.mutate()}
          disabled={decisionPending || !criteriaComplete}
        >
          <IconCheckCircle />
          Submit Decision
        </button>
        {!awaitingConfirmation ? (
          <button
            type="button"
            className="button-secondary"
            onClick={() => queue.skip.mutate()}
            disabled={queue.skip.isPending || submit.isPending}
          >
            <IconArrowRight />
            Skip for now
          </button>
        ) : null}
      </div>
      {queue.skip.error ? <p className="error" role="alert">{queue.skip.error.message}</p> : null}
    </article>
  )
}
