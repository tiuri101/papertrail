import { type ReactNode, useId, useState } from 'react'

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
}: CollapsibleSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const contentId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const toggle = () => setExpanded((current) => !current)
  const titleContent = (
    <span className="collapsible-section__title">
      {icon ? <span className="collapsible-section__icon" aria-hidden="true">{icon}</span> : null}
      {subtitle ? (
        <span className="collapsible-section__title-text">
          <span className="collapsible-section__subtitle" aria-hidden="true">{subtitle}</span>
          <span>{title}</span>
        </span>
      ) : title}
    </span>
  )

  return (
    <section
      id={id}
      className={['card', 'collapsible-section', className].filter(Boolean).join(' ')}
    >
      {headingAccessory ? (
        <Heading className="collapsible-section__heading collapsible-section__heading--with-accessory" aria-label={title}>
          <button
            type="button"
            className="collapsible-section__toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            {titleContent}
          </button>
          <span className="collapsible-section__heading-accessory">{headingAccessory}</span>
          <button
            type="button"
            className="collapsible-section__indicator-toggle"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${title}`}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            <span className="collapsible-section__indicator" aria-hidden="true">
              {expanded ? '−' : '+'}
            </span>
          </button>
        </Heading>
      ) : (
        <Heading className="collapsible-section__heading">
          <button
            type="button"
            className="collapsible-section__toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={toggle}
          >
            {titleContent}
            <span className="collapsible-section__indicator" aria-hidden="true">
              {expanded ? '−' : '+'}
            </span>
          </button>
        </Heading>
      )}
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
