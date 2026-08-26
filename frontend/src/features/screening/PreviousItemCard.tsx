import { toolbarClass } from '../../components/layoutStyles'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { formatHotkey, loadScreeningHotkeys } from '../../lib/screeningHotkeys'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import { useScreeningDecisionHotkeys } from './useScreeningDecisionHotkeys'
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

  useScreeningDecisionHotkeys({
    enabled: Boolean(decision),
    setOutcome,
    onSubmit: () => {
      if (save.isPending || !criteriaComplete) return
      save.mutate({ outcome, criteriaAnswers: answers, notes: notes || null })
    },
  })
  const submitHotkey = formatHotkey(loadScreeningHotkeys().submit)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    titleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [previousItem.id])

  return (
    <Card as="article">
      <p className="text-text-muted">You went back to the previous paper. Changes here update your existing decision.</p>
      <h2 ref={titleRef} className="scroll-mt-[92px]"><HighlightedText text={previousItem.publication.title} keywords={highlightKeywords} /></h2>
      <p>{previousItem.publication.authors ?? 'Unknown authors'}</p>
      {previousItem.publication.venue ? <p className="text-text-muted">{previousItem.publication.venue}</p> : null}
      <p>
        {previousItem.publication.abstract
          ? <HighlightedText text={previousItem.publication.abstract} keywords={highlightKeywords} />
          : 'No abstract available.'}
      </p>
      <div className={toolbarClass}>
        <DoiPill doi={previousItem.publication.doi} />
        {isSafeHttpUrl(previousItem.publication.publisherUrl) ? (
          <PublisherLinkPill url={previousItem.publication.publisherUrl} />
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
            criteria={previousItem.criteria}
            setCriteriaAnswers={setAnswers}
          />
          {!criteriaComplete ? <p className="text-text-muted">Answer every criterion before saving.</p> : null}
          {save.error ? <p className="text-danger" role="alert">{save.error.message}</p> : null}
          <div className={toolbarClass}>
            <Button
              type="button"
              onClick={() => save.mutate({ outcome, criteriaAnswers: answers, notes: notes || null })}
              disabled={save.isPending || !criteriaComplete}
            >
              Save Changes
              {submitHotkey ? <kbd className="submit-button__hotkey inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-[rgba(255,255,255,0.5)] bg-[rgba(255,255,255,0.16)] px-[5px] text-[0.72rem] leading-none font-bold text-inherit opacity-[0.85] [font-family:inherit]" aria-hidden="true">{submitHotkey}</kbd> : null}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.isPending}>
              Continue to current paper
            </Button>
          </div>
        </>
      ) : (
        <div className={toolbarClass}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Continue to current paper
          </Button>
        </div>
      )}
    </Card>
  )
}
