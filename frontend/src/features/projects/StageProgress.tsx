import { Fragment, useEffect, useRef, type CSSProperties } from 'react'

import { IconCheck } from '../../components/icons'

export const STAGES = [
  { value: 'draft', label: 'Draft', color: '#2a78d6' },
  { value: 'duplicate_review', label: 'Duplicate Review', color: '#eb6834' },
  { value: 'title_abstract_screening', label: 'Title/Abstract Screening', color: '#1baf7a' },
  { value: 'full_text_screening', label: 'Full-Text Screening', color: '#eda100' },
  { value: 'extraction_quality', label: 'Extraction & Quality', color: '#e87ba4' },
  { value: 'completed', label: 'Completed', color: '#008300' },
] as const

export function StageProgress({ stage }: { stage: string }) {
  const currentRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [stage])

  return (
    <div className="stage-steps-wrap">
      <ol className="stage-steps" aria-label="Project stage">
        {STAGES.map((step) => (
          <li
            key={step.value}
            ref={step.value === stage ? currentRef : undefined}
            className="stage-step"
            style={{ backgroundColor: step.color }}
            aria-current={step.value === stage ? 'step' : undefined}
          >
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A compact dot-and-connector summary of stage progress, for use on project cards. */
export function ProjectProgressDots({ stage }: { stage: string }) {
  const currentIndex = STAGES.findIndex((step) => step.value === stage)
  const accentColor = STAGES[currentIndex]?.color ?? STAGES[STAGES.length - 1].color
  const accentStyle = { '--progress-accent': accentColor } as CSSProperties

  return (
    <div className="progress-dots" aria-hidden="true">
      {STAGES.map((step, index) => (
        <Fragment key={step.value}>
          {index > 0 ? (
            <span
              className={`progress-connector ${index <= currentIndex ? 'progress-connector--done' : ''}`}
              style={index <= currentIndex ? accentStyle : undefined}
            />
          ) : null}
          <span
            className={
              index < currentIndex
                ? 'progress-dot progress-dot--done'
                : index === currentIndex
                  ? 'progress-dot progress-dot--current'
                  : 'progress-dot progress-dot--pending'
            }
            style={index <= currentIndex ? accentStyle : undefined}
            title={step.label}
          >
            {index < currentIndex ? <IconCheck /> : null}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
