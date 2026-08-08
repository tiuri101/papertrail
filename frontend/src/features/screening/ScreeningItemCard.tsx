import { HighlightedText } from '../../components/HighlightedText'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { ScreeningQueue } from './useScreeningQueue'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'

export function ScreeningItemCard(queue: ScreeningQueue & { highlightKeywords: string[] }) {
  const { item, answers, setAnswers, outcome, setOutcome, notes, setNotes, criteriaComplete, submit, highlightKeywords } = queue
  if (!item) return null

  return (
    <article className="card">
      <h2><HighlightedText text={item.publication.title} keywords={highlightKeywords} /></h2>
      <p>{item.publication.authors ?? 'Unknown authors'}</p>
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
      <ScreeningLlmPanel
        projectId={queue.projectId}
        publicationId={item.publication.id}
        itemId={item.id}
        stage={queue.stage as 'title_abstract' | 'full_text'}
      />
      <CriteriaAnswerFields
        criteria={item.criteria}
        answers={answers}
        setAnswers={setAnswers}
        outcome={outcome}
        setOutcome={setOutcome}
        notes={notes}
        setNotes={setNotes}
      />
      {!criteriaComplete ? (
        <p className="muted">Answer every criterion before submitting.</p>
      ) : null}
      {submit.error ? (
        <p className="error" role="alert">{submit.error.message}</p>
      ) : null}
      <button
        type="button"
        onClick={() => submit.mutate()}
        disabled={submit.isPending || !criteriaComplete}
      >
        Submit Decision
      </button>
    </article>
  )
}

export function SubmittedScreeningCard({ queue }: { queue: ScreeningQueue }) {
  const submitted = queue.submitted
  if (!submitted) return null
  return (
    <article className="card">
      <h2>{submitted.item.publication.title}</h2>
      <p><strong>Your decision:</strong> {submitted.decision.outcome}</p>
      <ScreeningLlmPanel
        projectId={queue.projectId}
        publicationId={submitted.item.publication.id}
        itemId={submitted.item.id}
        stage={queue.stage as 'title_abstract' | 'full_text'}
        humanDecision={submitted.decision.outcome}
      />
      <button type="button" onClick={queue.continueAfterDecision}>Continue to next paper</button>
    </article>
  )
}
