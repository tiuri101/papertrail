import { useState } from 'react'

import { HighlightedText } from '../../components/HighlightedText'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { CriterionAnswer, PreviousScreeningItem, ScreeningQueue } from './useScreeningQueue'

export function PreviousItemCard({
  projectId,
  stage,
  previousItem,
  highlightKeywords,
  onClose,
  save,
}: {
  projectId: string
  stage: string
  previousItem: PreviousScreeningItem
  highlightKeywords: string[]
  onClose: () => void
  save: ScreeningQueue['savePreviousDecision']
}) {
  const decision = previousItem.decision
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>(
    () => Object.fromEntries(
      previousItem.criteria.map((criterion) => [criterion.id, decision?.criteriaAnswers[criterion.id] ?? null]),
    ),
  )
  const [outcome, setOutcome] = useState(decision?.outcome ?? 'include')
  const [notes, setNotes] = useState(decision?.notes ?? '')

  const criteriaComplete = previousItem.criteria.every(
    (criterion) => answers[criterion.id] !== null && answers[criterion.id] !== undefined,
  )

  return (
    <article className="card">
      <p className="muted">You went back to the previous paper. Changes here update your existing decision.</p>
      <h2><HighlightedText text={previousItem.publication.title} keywords={highlightKeywords} /></h2>
      <p>{previousItem.publication.authors ?? 'Unknown authors'}</p>
      {previousItem.publication.venue ? <p className="muted">{previousItem.publication.venue}</p> : null}
      <p>
        {previousItem.publication.abstract
          ? <HighlightedText text={previousItem.publication.abstract} keywords={highlightKeywords} />
          : 'No abstract available.'}
      </p>
      <div className="toolbar">
        {previousItem.publication.doi ? (
          <a href={`https://doi.org/${previousItem.publication.doi}`} target="_blank" rel="noreferrer">
            Open DOI
          </a>
        ) : null}
        {isSafeHttpUrl(previousItem.publication.publisherUrl) ? (
          <a href={previousItem.publication.publisherUrl} target="_blank" rel="noreferrer">
            Open publisher page
          </a>
        ) : null}
      </div>
      {decision ? (
        <>
          <CriteriaAnswerFields
            criteria={previousItem.criteria}
            answers={answers}
            setAnswers={setAnswers}
            outcome={outcome}
            setOutcome={setOutcome}
            notes={notes}
            setNotes={setNotes}
          />
          <ScreeningLlmPanel
            projectId={projectId}
            publicationId={previousItem.publication.id}
            itemId={previousItem.id}
            stage={stage as 'title_abstract' | 'full_text'}
            humanDecision={outcome}
            criteriaAnswers={answers}
          />
          {!criteriaComplete ? <p className="muted">Answer every criterion before saving.</p> : null}
          {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
          <div className="toolbar">
            <button
              type="button"
              onClick={() => save.mutate({ outcome, criteriaAnswers: answers, notes: notes || null })}
              disabled={save.isPending || !criteriaComplete}
            >
              Save Changes
            </button>
            <button type="button" className="button-secondary" onClick={onClose} disabled={save.isPending}>
              Continue to current paper
            </button>
          </div>
        </>
      ) : (
        <div className="toolbar">
          <button type="button" className="button-secondary" onClick={onClose}>
            Continue to current paper
          </button>
        </div>
      )}
    </article>
  )
}
