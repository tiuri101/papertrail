import { type ReactNode, useId, useState } from 'react'

interface CollapsibleSectionProps {
  id?: string
  title: string
  icon?: ReactNode
  children: ReactNode
  className?: string
  defaultExpanded?: boolean
}

export function CollapsibleSection({
  id,
  title,
  icon,
  children,
  className,
  defaultExpanded = true,
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useId()

  return (
    <section
      id={id}
      className={['card', 'collapsible-section', className].filter(Boolean).join(' ')}
    >
      <h2 className="collapsible-section__heading">
        <button
          type="button"
          className="collapsible-section__toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="collapsible-section__title">
            {icon ? <span className="collapsible-section__icon" aria-hidden="true">{icon}</span> : null}
            {title}
          </span>
          <span className="collapsible-section__indicator" aria-hidden="true">
            {expanded ? '−' : '+'}
          </span>
        </button>
      </h2>
      <div
        id={contentId}
        className="collapsible-section__content"
        data-expanded={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="collapsible-section__content-inner">
          {children}
        </div>
      </div>
    </section>
  )
}
