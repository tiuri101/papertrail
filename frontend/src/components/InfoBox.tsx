import type { ReactNode } from 'react'

export function InfoBox({ icon, children, tone = 'info', alert = false }: {
  icon: ReactNode
  children: ReactNode
  tone?: 'info' | 'warning' | 'danger'
  alert?: boolean
}) {
  const toneClass = tone === 'info' ? '' : ` info-box--${tone}`
  return (
    <div className={`info-box${toneClass}`} role={alert ? 'alert' : undefined}>
      <span className="info-box__icon" aria-hidden="true">{icon}</span>
      <div className="info-box__content">{children}</div>
    </div>
  )
}
