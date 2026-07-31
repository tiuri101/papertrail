import { HighlightedText } from '../../components/HighlightedText'
import type { ScreeningCriterion, ScreeningQueue } from './useScreeningQueue'

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function sortedByKind(criteria: ScreeningCriterion[]): ScreeningCriterion[] {
  return [...criteria].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'inclusion' ? -1 : 1))
}

function criterionNumbers(criteria: ScreeningCriterion[]): Record<string, string> {
  const counts: Record<string, number> = {}
  const numbers: Record<string, string> = {}
  criteria.forEach((criterion) => {
    const prefix = criterion.kind === 'inclusion' ? 'IC' : 'EC'
    const count = (counts[criterion.kind] ?? 0) + 1
    counts[criterion.kind] = count
    numbers[criterion.id] = `${prefix}${count}`
  })
  return numbers
}

export function ScreeningItemCard(queue: ScreeningQueue & { highlightKeywords: string[] }) {
  const { item, answers, setAnswers, outcome, setOutcome, notes, setNotes, criteriaComplete, submit, highlightKeywords } = queue
  if (!item) return null
  const numbers = criterionNumbers(item.criteria)

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
        {item.publication.publisherUrl ? (
          <a
            href={item.publication.publisherUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open publisher page
          </a>
        ) : null}
      </div>
      <h3>Criteria</h3>
      <table className="criteria-table">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Fulfilled</th>
            <th scope="col">Not fulfilled</th>
          </tr>
        </thead>
        <tbody>
          {sortedByKind(item.criteria).map((criterion) => (
            <tr key={criterion.id}>
              <th scope="row">{numbers[criterion.id]}: {criterion.text}</th>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Fulfilled`}
                  checked={answers[criterion.id] === true}
                  onChange={(event) => setAnswers((current) => ({
                    ...current,
                    [criterion.id]: event.target.checked ? true : null,
                  }))}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Not fulfilled`}
                  checked={answers[criterion.id] === false}
                  onChange={(event) => setAnswers((current) => ({
                    ...current,
                    [criterion.id]: event.target.checked ? false : null,
                  }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Decision
        <select
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="include">Include</option>
          <option value="exclude">Exclude</option>
          <option value="uncertain">Uncertain</option>
          <option value="duplicate">Duplicate</option>
        </select>
      </label>
      <label>
        Notes
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
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
        Submit decision
      </button>
    </article>
  )
}
