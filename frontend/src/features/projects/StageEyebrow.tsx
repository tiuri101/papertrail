import type { CSSProperties } from 'react'

import { STAGES } from './StageProgress'

export type ProjectStageValue = (typeof STAGES)[number]['value']

const ADMINISTRATION_COLOR = 'var(--color-text)'

export function StageEyebrow({ stage }: { stage: ProjectStageValue }) {
  const definition = STAGES.find((item) => item.value === stage)
  if (!definition) return null
  return (
    <p
      className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-(--stage-color)"
      style={{ '--stage-color': definition.color } as CSSProperties}
    >
      {definition.label}
    </p>
  )
}

export function AdministrationEyebrow() {
  return (
    <p
      className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-(--stage-color)"
      style={{ '--stage-color': ADMINISTRATION_COLOR } as CSSProperties}
    >
      Administration
    </p>
  )
}
