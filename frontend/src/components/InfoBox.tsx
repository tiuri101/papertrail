import type { ReactNode } from 'react'

export function InfoBox({ icon, children, tone = 'info', alert = false }: {
  icon: ReactNode
  children: ReactNode
  tone?: 'info' | 'warning'
  alert?: boolean
}) {
  return (
    <div className={tone === 'warning' ? 'info-box info-box--warning' : 'info-box'} role={alert ? 'alert' : undefined}>
      <span className="info-box__icon" aria-hidden="true">{icon}</span>
      <div className="info-box__content">{children}</div>
    </div>
  )
}
