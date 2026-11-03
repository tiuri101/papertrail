import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { describeError } from '../../api/domainErrors'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { FormField } from '../../components/FormField'
import { IconCopy } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { toolbarClass } from '../../components/layoutStyles'
import type { BackgroundJob } from '../jobs/jobStatus'
import { usePendingJob } from '../jobs/usePendingJob'

interface CopyResult {
  projectId: string
  projectName: string
  missingFiles?: number
}

export function CopyProjectPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<{ name: string }>(`/api/v1/projects/${projectId}`),
  })
  // Null until the user edits it, so the default follows the project's name once it loads.
  const [name, setName] = useState<string | null>(null)
  const [finishedJob, setFinishedJob] = useState<BackgroundJob | null>(null)
  const { pendingJobId, setPendingJobId } = usePendingJob(projectId, {
    onComplete: (job) => {
      setFinishedJob(job)
      if (job.status === 'completed') queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const copy = useMutation({
    mutationFn: (copyName: string) =>
      apiRequest<BackgroundJob>(`/api/v1/projects/${projectId}/clone`, {
        method: 'POST',
        body: JSON.stringify({ name: copyName }),
      }),
    onSuccess: (job) => {
      setFinishedJob(null)
      setPendingJobId(job.id)
    },
  })

  const defaultName = project.data ? `Copy of ${project.data.name}` : ''
  const copyName = (name ?? defaultName).trim()
  const inProgress = copy.isPending || pendingJobId !== null
  const result = finishedJob?.status === 'completed' ? (finishedJob.result as CopyResult | null) : null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (copyName) copy.mutate(copyName)
  }

  return (
    <CollapsibleSection id="section-copy-project" title="Copy Project" icon={<IconCopy />}>
      <InfoBox icon={<IconCopy />}>
        <p>
          Creates a new, independent project in exactly this project's current state: configuration,
          members, publications, imports, PDFs, duplicate review, screening, extraction, quality
          assessment, AI suggestions, and the audit log. You become the copy's owner. Changes to
          either project afterwards do not affect the other. Generated exports are not copied.
        </p>
      </InfoBox>
      <form onSubmit={submit}>
        <FormField label="Name of the copy">
          <Input
            value={name ?? defaultName}
            onChange={(event) => setName(event.target.value)}
            maxLength={250}
            required
          />
        </FormField>
        {copy.error ? <p className="text-danger" role="alert">{describeError(copy.error)}</p> : null}
        {finishedJob && finishedJob.status !== 'completed' ? (
          <p className="text-danger" role="alert">
            Copying failed: {finishedJob.errorMessage ?? 'unknown error'}
          </p>
        ) : null}
        {inProgress ? <p role="status">Copying project… this can take a while for projects with many PDFs.</p> : null}
        {result ? (
          <p role="status">
            Created <Link to={`/projects/${result.projectId}`}>{result.projectName}</Link>.
            {result.missingFiles
              ? ` ${result.missingFiles} file(s) were already missing from this project and could not be copied.`
              : null}
          </p>
        ) : null}
        <div className={toolbarClass}>
          <Button type="submit" startIcon={<IconCopy />} disabled={!copyName || inProgress} loading={inProgress}>
            Copy Project
          </Button>
        </div>
      </form>
    </CollapsibleSection>
  )
}
