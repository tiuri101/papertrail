import { type ReactNode, useId, useState } from 'react'

import { cn } from '../lib/cn'
import { cardPageSiblingSpacingStyles, cardPaddingStyles, cardShapeStyles, cardShellStyles } from './Card'

// Mirrors cardPaddingStyles' breakpoints/values but only on the top+x axes, so the header button can
// span the full card width (for a larger click target) while reproducing the exact inset a plain
// Card's padding would give its heading. Deliberately axis-scoped (no bottom) to avoid two classes
// fighting over the same CSS property.
const headerPaddingTopXStyles = 'pt-6 px-6 max-[760px]:pt-5 max-[760px]:px-5 max-[480px]:pt-4 max-[480px]:px-4'
const headerNegativeMarginTopXStyles = '-mt-6 -mx-6 max-[760px]:-mt-5 max-[760px]:-mx-5 max-[480px]:-mt-4 max-[480px]:-mx-4'

// Full shell per tone (not just a border/background override) so a differently-toned section never
// carries two conflicting utilities for the same CSS property fighting over Tailwind's generated
// source order — the exact bug that left danger-zone cards rendering with the default blue-ish shell.
const shellByTone = {
  default: cardShellStyles,
  danger: cn(cardShapeStyles, 'border border-danger/30 bg-linear-to-b from-danger-container to-surface'),
} as const

const textByTone = {
  default: '',
  danger: '[&_h2]:text-danger [&_h3]:text-danger [&_.collapsible-section__icon]:text-danger',
} as const

interface CollapsibleSectionProps {
  id?: string
  title: string
  subtitle?: string
  icon?: ReactNode
  headingAccessory?: ReactNode
  children: ReactNode
  className?: string
  defaultExpanded?: boolean
  headingLevel?: 2 | 3
  /** Visual tone; 'danger' is used for destructive/irreversible actions (e.g. a project danger zone). */
  tone?: keyof typeof shellByTone
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  icon,
  headingAccessory,
  children,
  className,
  defaultExpanded = true,
  headingLevel = 2,
  tone = 'default',
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const toggle = () => setExpanded((current) => !current)
  const titleContent = (
    <span className="collapsible-section__title inline-flex items-center gap-2">
      {icon ? <span className="collapsible-section__icon inline-flex shrink-0 text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true">{icon}</span> : null}
      {subtitle ? (
        <span className="collapsible-section__title-text grid">
          <span className="collapsible-section__subtitle text-xs font-bold uppercase leading-[1.35] tracking-[0.08em] text-text-secondary" aria-hidden="true">{subtitle}</span>
          <span>{title}</span>
        </span>
      ) : title}
    </span>
  )

  return (
    <section
      id={id}
      className={cn(
        'collapsible-section',
        shellByTone[tone],
        cardPageSiblingSpacingStyles,
        expanded ? cardPaddingStyles : 'p-0',
        textByTone[tone],
        className,
      )}
      data-ui="card"
      data-expanded={expanded}
    >
      {headingAccessory ? (
        <Heading className={cn('collapsible-section__heading collapsible-section__heading--with-accessory m-0 flex items-center gap-2', expanded ? cn(headerNegativeMarginTopXStyles, headerPaddingTopXStyles) : cardPaddingStyles)} aria-label={title}>
          <button
            type="button"
            className="collapsible-section__toggle inline-flex h-auto min-h-0 w-auto cursor-pointer items-center justify-between border-0 bg-none bg-transparent p-0 text-left text-[1.25rem] leading-[1.2] font-[680] tracking-[-0.018em] text-[inherit] shadow-none hover:bg-none hover:text-primary focus-visible:rounded-sm focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-focus"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            {titleContent}
          </button>
          <span className="collapsible-section__heading-accessory inline-flex shrink-0">{headingAccessory}</span>
          <button
            type="button"
            className="collapsible-section__indicator-toggle ml-auto inline-flex h-auto min-h-0 w-auto shrink-0 cursor-pointer border-0 bg-none bg-transparent p-0 text-[inherit] shadow-none hover:bg-none hover:text-primary focus-visible:rounded-sm focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-focus"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            <span className="collapsible-section__indicator shrink-0 text-[1.4rem] leading-none text-text-secondary" aria-hidden="true">
              {expanded ? '−' : '+'}
            </span>
          </button>
        </Heading>
      ) : (
        <Heading className={cn('collapsible-section__heading m-0', expanded && headerNegativeMarginTopXStyles)}>
          <button
            type="button"
            className={cn(
              'collapsible-section__toggle inline-flex h-auto min-h-0 w-full cursor-pointer items-center justify-between border-0 bg-none bg-transparent text-left text-[1.25rem] leading-[1.2] font-[680] tracking-[-0.018em] text-[inherit] shadow-none hover:bg-none hover:text-primary focus-visible:rounded-sm focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-focus',
              expanded ? headerPaddingTopXStyles : cardPaddingStyles,
            )}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            {titleContent}
            <span className="collapsible-section__indicator shrink-0 text-[1.4rem] leading-none text-text-secondary" aria-hidden="true">
              {expanded ? '−' : '+'}
            </span>
          </button>
        </Heading>
      )}
      <div
        id={contentId}
        className={cn(
          'collapsible-section__content grid transition-[grid-template-rows,margin-top,opacity,visibility] duration-100',
          expanded ? 'visible mt-4 grid-rows-[1fr] opacity-100' : 'invisible mt-0 grid-rows-[0fr] opacity-0',
        )}
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="collapsible-section__content-inner min-h-0 overflow-hidden [&>*+*]:mt-5 [&>.toolbar:last-child]:mb-0">
          {children}
        </div>
      </div>
    </section>
  )
}
