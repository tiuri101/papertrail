import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'

const stages = [
  'draft',
  'duplicate_review',
  'title_abstract_screening',
  'full_text_screening',
  'extraction_quality',
]

export function ProjectLifecyclePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [targetStage, setTargetStage] = useState(stages[2])
  const integrity = useQuery({
    queryKey: ['project-integrity', projectId],
    queryFn: () => api<{ issues: Array<{ code: string; message: string }> }>(
      `/projects/${projectId}/integrity`,
    ),
  })
  const reopen = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ targetStage }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Workflow integrity</h2>
      {integrity.data?.issues.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {integrity.data.issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : <p>No consistency issues detected.</p>}
      <label className="block max-w-md">
        <span className="mb-1 block text-sm font-medium">Reopen completed project at</span>
        <select
          className="w-full rounded-lg border px-3 py-2"
          value={targetStage}
          onChange={(event) => setTargetStage(event.target.value)}
        >
          {stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
        </select>
      </label>
      <button
        className="rounded-lg bg-slate-900 px-4 py-2 text-white"
        type="button"
        onClick={() => reopen.mutate()}
        disabled={reopen.isPending}
      >
        Reopen project
      </button>
    </section>
  )
}
