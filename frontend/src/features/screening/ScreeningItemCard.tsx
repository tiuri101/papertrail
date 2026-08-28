import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

import { DoiPill } from '../../components/DoiPill'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { HighlightedText } from '../../components/HighlightedText'
import { IconArrowRight, IconCheckCircle } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { usePaperTextStyle } from '../../hooks/usePaperTextStyle'
import { useUiPreference } from '../../hooks/useUiPreferences'
import { formatYearVenue } from '../../lib/format'
import { DEFAULT_SCREENING_HOTKEYS, formatHotkey, SCREENING_HOTKEYS_PREFERENCE_KEY, type ScreeningHotkeys } from '../../lib/screeningHotkeys'
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

  const { value: hotkeys } = useUiPreference<ScreeningHotkeys>(SCREENING_HOTKEYS_PREFERENCE_KEY, DEFAULT_SCREENING_HOTKEYS)
  const paperTextStyle = usePaperTextStyle()

  if (!item) return null
  const decisionError = awaitingConfirmation ? queue.reviseDecision.error : submit.error
  const submitHotkey = formatHotkey(hotkeys.submit)
  const abstractContent = item.publication.abstract
    ? <HighlightedText text={item.publication.abstract} keywords={highlightKeywords} />
    : 'No abstract available.'

  const yearVenue = formatYearVenue(item.publication.publicationYear, item.publication.venue)

  return (
    <Card as="article">
      <h2 ref={titleRef} className="scroll-mt-[92px]" style={paperTextStyle.title}>
        <Link to={`/projects/${queue.projectId}/publications/${item.publication.id}`} target="_blank" rel="noreferrer">
          <HighlightedText text={item.publication.title} keywords={highlightKeywords} />
        </Link>
      </h2>
      <div className="flex flex-wrap items-center gap-3 mt-2">
        <DoiPill doi={item.publication.doi} />
        {isSafeHttpUrl(item.publication.publisherUrl) ? (
          <PublisherLinkPill url={item.publication.publisherUrl} />
        ) : null}
      </div>
      <p>{item.publication.authors ?? 'Unknown authors'}</p>
      {yearVenue ? <p className="text-text-muted">{yearVenue}</p> : null}
      {isFullTextStage ? (
        <details className="rounded-md border border-border bg-bg-elevated px-4 py-3 [&_summary]:cursor-pointer [&_summary]:font-semibold [&_p]:mb-0 [&_p]:mt-3">
          <summary>Abstract</summary>
          <p style={paperTextStyle.abstract}>{abstractContent}</p>
        </details>
      ) : (
        <p style={paperTextStyle.abstract}>{abstractContent}</p>
      )}
      {isFullTextStage && fullTextDocument.data ? (
        <div className="flex flex-wrap items-center gap-3">
          <PdfAvailabilityPill
            available={fullTextDocument.data.available}
            href={`${fullTextDocumentEndpoint(queue.projectId, item.publication.id)}/content`}
            pageCount={fullTextDocument.data.document?.pageCount}
          />
        </div>
      ) : null}
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
        <p className="text-text-muted">Answer every criterion before {awaitingConfirmation ? 'confirming' : 'submitting'}.</p>
      ) : null}
      {decisionError ? (
        <p className="text-danger" role="alert">{decisionError.message}</p>
      ) : null}
      <div className={toolbarClass}>
        <Button
          type="button"
          variant="primary"
          onClick={() => awaitingConfirmation ? queue.confirmDecision() : submit.mutate()}
          disabled={decisionPending || !criteriaComplete}
        >
          <IconCheckCircle />
          {awaitingConfirmation ? 'Confirm Decision' : 'Submit Decision'}
          {submitHotkey ? <kbd className="submit-button__hotkey inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-[5px] border border-[rgba(255,255,255,0.5)] bg-[rgba(255,255,255,0.16)] px-[5px] text-[0.72rem] leading-none font-bold text-inherit opacity-[0.85] [font-family:inherit]" aria-hidden="true">{submitHotkey}</kbd> : null}
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
      {queue.skip.error ? <p className="text-danger" role="alert">{queue.skip.error.message}</p> : null}
    </Card>
  )
}
