import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { getCsrfToken } from '../auth/session'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'

interface SearchSource {
  id: string
  sourceName: string
  query: string
  searchDate: string
  filters: string | null
}

interface ImportResult { jobId: string }

export function ImportPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [query, setQuery] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [filters, setFilters] = useState('')
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)

  const searches = useQuery({
    queryKey: ['searches', projectId],
    queryFn: () => apiRequest<SearchSource[]>(`/api/v1/projects/${projectId}/searches`),
    enabled: Boolean(projectId),
  })

  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJob = pendingJobId ? findJob(jobs.data, pendingJobId) : undefined

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    }
  }, [pendingJob, projectId, queryClient])

  const submit = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      if (!file) throw new Error('Choose a file')

      const search = await apiRequest<SearchSource>(`/api/v1/projects/${projectId}/searches`, {
        method: 'POST',
        body: JSON.stringify({
          sourceName,
          query,
          searchDate,
          filters: filters.trim() || null,
        }),
      })

      const form = new FormData()
      form.append('file', file)
      form.append('searchSourceId', search.id)
      const response = await fetch(`/api/v1/projects/${projectId}/imports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() ?? '' },
        body: form,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message ?? 'Import failed')
      }
      return response.json() as Promise<ImportResult>
    },
    onSuccess: (result) => {
      setSourceName('')
      setQuery('')
      setSearchDate('')
      setFilters('')
      setFile(null)
      setPendingJobId(result.jobId)
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
    },
  })

  return (
    <main className="page">
      <h1>Import records</h1>

      <section className="card">
        <h2>Import an export file</h2>
        <p className="muted">Record the database and search string used alongside the file, so it can be traced back for this import and reported in your PRISMA flow.</p>
        {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
          <label>
            Database
            <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} required />
          </label>
          <label>
            Search string
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} required />
          </label>
          <label>
            Search date
            <input type="date" value={searchDate} onChange={(event) => setSearchDate(event.target.value)} required />
          </label>
          <label>
            Filters applied (optional)
            <input value={filters} onChange={(event) => setFilters(event.target.value)} />
          </label>
          <label>Bibliographic export
            <input type="file" accept=".csv,.tsv,.xlsx,.ris,.bib,.bibtex" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" disabled={!file || submit.isPending}>Upload</button>
        </form>
        {submit.data ? (
          !pendingJob || isJobActive(pendingJob.status) ? (
            <p>Import queued: {submit.data.jobId}</p>
          ) : pendingJob.status === 'completed' ? (
            <p>Import complete.</p>
          ) : (
            <p className="error" role="alert">
              Import {pendingJob.status}
              {pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
            </p>
          )
        ) : null}
        {searches.data?.length ? (
          <>
            <h3>Previously documented searches</h3>
            <ul>
              {searches.data.map((search) => (
                <li key={search.id}>
                  <strong>{search.sourceName}</strong>: {search.query} — {search.searchDate}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </main>
  )
}
