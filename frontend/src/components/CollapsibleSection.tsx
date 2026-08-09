import { type ReactNode, useId, useState } from 'react'

interface CollapsibleSectionProps {
  id?: string
  title: string
  children: ReactNode
  className?: string
  defaultExpanded?: boolean
}

export function CollapsibleSection({
  id,
  title,
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
          <span>{title}</span>
          <span className="collapsible-section__indicator" aria-hidden="true">
            {expanded ? '−' : '+'}
          </span>
        </button>
      </h2>
      <div
        id={contentId}
        className="collapsible-section__content"
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  )
}
