import type { ReactNode } from 'react'

interface CountPillProps {
  count: number
  children: ReactNode
  className?: string
  prefix?: ReactNode
}

export function CountPill({ count, children, className = '', prefix }: CountPillProps) {
  return (
    <p className={`count-pill${className ? ` ${className}` : ''}`}>
      <span className="visually-hidden">{prefix ? <>{prefix} </> : null}{count} {children}</span>
      {prefix ? <span aria-hidden="true">{prefix}</span> : null}
      <strong aria-hidden="true">{count}</strong>
      <span aria-hidden="true">{children}</span>
    </p>
  )
}
