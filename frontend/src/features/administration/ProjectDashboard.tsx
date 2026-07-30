import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'

export function ProjectDashboard({ projectId }: { projectId: string }) {
  const dashboard = useQuery({
    queryKey: ['project-dashboard', projectId],
    queryFn: () => api<Record<string, number | string>>(`/projects/${projectId}/dashboard`),
  })

  if (dashboard.isLoading) return <p>Loading project status…</p>
  if (dashboard.isError || !dashboard.data) return <p>Project status could not be loaded.</p>

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">Project status</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(dashboard.data).map(([key, value]) => (
          <article className="rounded-lg border p-4" key={key}>
            <p className="text-sm text-slate-500">{key}</p>
            <p className="text-2xl font-semibold">{value}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
