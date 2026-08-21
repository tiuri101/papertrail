import { Fragment, useEffect, useRef, type CSSProperties } from 'react'

import { IconCheck } from '../../components/icons'
import { cn } from '../../lib/cn'

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
    <div className="mb-6 overflow-x-auto rounded-md border border-border bg-surface p-2 [scrollbar-width:thin]">
      <ol className="m-0 flex w-fit min-w-full list-none p-0" aria-label="Project stage">
        {STAGES.map((step) => (
          <li
            key={step.value}
            ref={step.value === stage ? currentRef : undefined}
            className="min-w-[150px] flex-auto px-[25px] py-[11px] text-center text-[0.79rem] font-bold whitespace-nowrap text-white opacity-30 saturate-50 transition-[filter,opacity,transform] duration-150 [clip-path:polygon(0_0,calc(100%_-_14px)_0,100%_50%,calc(100%_-_14px)_100%,0_100%,14px_50%)] first:[clip-path:polygon(0_0,calc(100%_-_14px)_0,100%_50%,calc(100%_-_14px)_100%,0_100%)] last:[clip-path:polygon(0_0,100%_0,100%_100%,0_100%,14px_50%)] not-first:-ml-[14px] not-first:pl-[39px] aria-[current=step]:z-1 aria-[current=step]:opacity-100 aria-[current=step]:saturate-100"
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
    <div className="flex items-center" aria-hidden="true">
      {STAGES.map((step, index) => (
        <Fragment key={step.value}>
          {index > 0 ? (
            <span
              className={cn('mx-[3px] h-0.5 min-w-2 flex-1 bg-border-strong', index <= currentIndex && 'bg-(--progress-accent)')}
              style={index <= currentIndex ? accentStyle : undefined}
            />
          ) : null}
          <span
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full text-primary-contrast [&_svg]:size-4',
              index < currentIndex && 'size-[22px] bg-(--progress-accent)',
              index === currentIndex && 'size-3.5 bg-(--progress-accent) shadow-[0_0_0_4px_color-mix(in_srgb,var(--progress-accent)_25%,transparent)]',
              index > currentIndex && 'size-2 border-2 border-border-strong bg-surface-hover',
            )}
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
