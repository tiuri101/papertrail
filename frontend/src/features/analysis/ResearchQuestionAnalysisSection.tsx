import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { LlmEvidence } from '../llm/LlmTaskComponents'
import { type BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import {
  useResearchQuestions,
  useRqAnalysis,
  type RqSourceRef,
  type RqStatement,
} from './useResearchQuestionAnalysis'

function formatSourceValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  return String(value)
}

function SourceBadge({
  sourceId,
  sourceRef,
  projectId,
}: {
  sourceId: string
  sourceRef: RqSourceRef | undefined
  projectId: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!sourceRef) {
    return <span className="rq-source-badge rq-source-badge--unknown">{sourceId}</span>
  }
  return (
    <span className="rq-source-badge-wrapper">
      <button
        type="button"
        className="rq-source-badge"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        {sourceId}
      </button>
      {expanded ? (
        <div className="rq-source-detail">
          <p className="muted">
            {sourceRef.publicationTitle} · {sourceRef.label}
            {' '}({sourceRef.sourceType === 'quality' ? 'Quality assessment' : 'Extraction'})
          </p>
          <p><strong>Value:</strong> {formatSourceValue(sourceRef.value)}</p>
          {sourceRef.evidence.length ? (
            <LlmEvidence
              evidence={sourceRef.evidence}
              projectId={projectId}
              publicationId={sourceRef.publicationId}
            />
          ) : (
            <p className="muted">No traceable source quotation for this value.</p>
          )}
        </div>
      ) : null}
    </span>
  )
}

function StatementRow({
  statement,
  sourceRefs,
  projectId,
}: {
  statement: RqStatement
  sourceRefs: Record<string, RqSourceRef>
  projectId: string
}) {
  return (
    <li className="rq-statement">
      <p>{statement.claim}</p>
      <div className="rq-statement__sources">
        {statement.sourceIds.map((sourceId) => (
          <SourceBadge
            key={sourceId}
            sourceId={sourceId}
            sourceRef={sourceRefs[sourceId]}
            projectId={projectId}
          />
        ))}
      </div>
    </li>
  )
}

function ResearchQuestionCard({
  projectId,
  researchQuestionId,
}: {
  projectId: string
  researchQuestionId: string
}) {
  const queryClient = useQueryClient()
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const analysis = useRqAnalysis(projectId, researchQuestionId)

  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJob = pendingJobId ? findJob(jobs.data, pendingJobId) : undefined

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      queryClient.invalidateQueries({
        queryKey: ['rq-analysis', projectId, researchQuestionId],
      })
      setPendingJobId(null)
    }
  }, [pendingJob, projectId, researchQuestionId, queryClient])

  const regenerate = useMutation({
    mutationFn: () => apiRequest<{ jobId: string }>(
      `/api/v1/projects/${projectId}/research-questions/${researchQuestionId}/analysis/regenerate`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      if (result.jobId) setPendingJobId(result.jobId)
    },
  })

  const isGenerating = Boolean(pendingJob && isJobActive(pendingJob.status)) || regenerate.isPending

  if (analysis.isLoading) return <p>Loading…</p>
  if (analysis.error || !analysis.data) {
    return <p className="error" role="alert">{analysis.error?.message ?? 'Could not load this research question.'}</p>
  }

  const data = analysis.data
  const run = data.latestRun

  return (
    <div className="rq-card">
      <div className="rq-card__header">
        <h3>{data.researchQuestionText}</h3>
        <button
          type="button"
          className="button-secondary"
          onClick={() => regenerate.mutate()}
          disabled={isGenerating || !data.synthesisEnabled}
        >
          {isGenerating ? 'Generating…' : run ? 'Regenerate' : 'Generate synthesis'}
        </button>
      </div>
      {!data.synthesisEnabled ? (
        <p className="muted">AI-generated interpretive analysis is disabled for this project.</p>
      ) : null}
      {regenerate.error ? <p className="error" role="alert">{regenerate.error.message}</p> : null}
      {pendingJob?.status === 'failed' ? (
        <p className="error" role="alert">
          Synthesis failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      {run ? (
        <>
          {data.isStale ? (
            <p className="stale-banner" role="status">
              This synthesis may be outdated — the underlying results have changed since it was
              generated.
            </p>
          ) : null}
          {run.status === 'failed' && run.error ? (
            <p className="error" role="alert">{run.error}</p>
          ) : null}
          {run.statements.length === 0 ? (
            <p className="muted">No supported statements could be generated from the current data.</p>
          ) : (
            <ul className="rq-statement-list">
              {run.statements.map((statement, index) => (
                <StatementRow
                  key={index}
                  statement={statement}
                  sourceRefs={run.sourceRefs}
                  projectId={projectId}
                />
              ))}
            </ul>
          )}
          {run.limitations.length > 0 ? (
            <div className="rq-limitations">
              <h4>Limitations</h4>
              <ul>
                {run.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
              </ul>
            </div>
          ) : null}
          {run.generatedAt ? (
            <p className="muted">Generated {new Date(run.generatedAt).toLocaleDateString()}</p>
          ) : null}
        </>
      ) : (
        <p className="muted">No synthesis generated yet.</p>
      )}
    </div>
  )
}

export function ResearchQuestionAnalysisSection({ projectId }: { projectId: string }) {
  const questions = useResearchQuestions(projectId)
  const researchQuestions = questions.data?.researchQuestions ?? []

  return (
    <section id="section-analysis-research-question" className="card">
      <h2>Research Question Analysis</h2>
      <p className="muted">
        AI-generated synthesis of the authoritative extraction and quality-assessment results for
        each research question, with every statement traceable to specific source facts.
      </p>
      {questions.error ? <p className="error" role="alert">{questions.error.message}</p> : null}
      {questions.data && researchQuestions.length === 0 ? (
        <p>No research questions have been defined for this project.</p>
      ) : null}
      {researchQuestions.map((question) => (
        <ResearchQuestionCard
          key={question.id}
          projectId={projectId}
          researchQuestionId={question.id}
        />
      ))}
    </section>
  )
}
