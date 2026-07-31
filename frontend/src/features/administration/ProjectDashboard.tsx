import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

export function ProjectDashboard({ projectId }: { projectId: string }) {
  const dashboard = useQuery({
    queryKey: ['project-dashboard', projectId],
    queryFn: () => api<Record<string, number | string>>(`/projects/${projectId}/dashboard`),
  })

  if (dashboard.isLoading) return <p>Loading project status…</p>
  if (dashboard.isError || !dashboard.data) return <p>Project status could not be loaded.</p>

  return (
    <section className="card">
      <h2>Project Status</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(dashboard.data).filter(([key]) => key !== 'stage').map(([key, value]) => (
            <tr key={key}>
              <th scope="row">{humanizeKey(key)}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
