import { HighlightedText } from '../../components/HighlightedText'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { ScreeningQueue } from './useScreeningQueue'

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
