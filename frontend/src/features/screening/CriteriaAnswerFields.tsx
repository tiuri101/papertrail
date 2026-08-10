import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'

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

export function CriteriaAnswerFields({
  criteria,
  answers,
  setAnswers,
  outcome,
  setOutcome,
  notes,
  setNotes,
}: {
  criteria: ScreeningCriterion[]
  answers: Record<string, CriterionAnswer>
  setAnswers: (updater: (current: Record<string, CriterionAnswer>) => Record<string, CriterionAnswer>) => void
  outcome: string
  setOutcome: (outcome: string) => void
  notes: string
  setNotes: (notes: string) => void
}) {
  const numbers = criterionNumbers(criteria)

  return (
    <>
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
          {sortedByKind(criteria).map((criterion) => (
            <tr key={criterion.id}>
              <th scope="row">
                <span className={`criterion-badge criterion-badge--${criterion.kind}`}>{numbers[criterion.id]}</span> {criterion.text}
              </th>
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
    </>
  )
}
