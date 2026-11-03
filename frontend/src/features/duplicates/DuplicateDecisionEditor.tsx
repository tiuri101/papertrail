import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconAlertTriangle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { toolbarClass } from '../../components/layoutStyles'
import { DuplicateComparisonCard } from './DuplicateComparisonCard'
import { DuplicateDecisionButtons } from './DuplicateDecisionButtons'
import { type Candidate, currentChoice, recommendedChoice } from './types'

interface ReviseBody {
  resolution: 'merge' | 'not_duplicate'
  canonicalPublicationId?: string
}

/**
 * Expanded editor for one already-resolved candidate: the A/B comparison plus
 * the three-way control, wired to POST .../duplicates/{id}/revise. Read-only
 * once later work builds on the decision (see canReviseDecision) — revisiting
 * it then needs "Move project back to duplicate review".
 */
export function DuplicateDecisionEditor({
  projectId,
  candidate,
  readOnly,
  onResolved,
  onClose,
}: {
  projectId: string
  candidate: Candidate
  readOnly: boolean
  onResolved?: (updated: Candidate) => void
  onClose: () => void
}) {
  const [current, setCurrent] = useState(candidate)

  const revise = useMutation({
    mutationFn: (body: ReviseBody) => apiRequest<Candidate>(
      `/api/v1/projects/${projectId}/duplicates/${current.id}/revise`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: (updated) => {
      setCurrent(updated)
      onResolved?.(updated)
    },
  })

  return (
    <>
      <DuplicateComparisonCard candidate={current} />
      {readOnly ? (
        <InfoBox icon={<IconAlertTriangle />} tone="warning" alert className="mt-4">
          <h3>This decision can no longer be changed here</h3>
          <p>
            Work in a later stage already builds on it. To revisit it, move the project
            back to duplicate review from the project page.
          </p>
        </InfoBox>
      ) : (
        <DuplicateDecisionButtons
          publicationAId={current.publicationA.id}
          publicationBId={current.publicationB.id}
          screenedA={current.publicationA.screened}
          screenedB={current.publicationB.screened}
          current={currentChoice(current)}
          recommended={recommendedChoice(current)}
          headline="Change this decision"
          hint="Pick a different record to keep, or mark the pair as distinct. Changing a merge undoes it first."
          disabled={revise.isPending}
          onMerge={(canonicalPublicationId) => revise.mutate({ resolution: 'merge', canonicalPublicationId })}
          onNotDuplicate={() => revise.mutate({ resolution: 'not_duplicate' })}
        />
      )}
      {revise.error ? <p className="text-danger" role="alert">{revise.error.message}</p> : null}
      <div className={toolbarClass}>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </>
  )
}
