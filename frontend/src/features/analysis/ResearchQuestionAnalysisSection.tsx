import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { IconFile } from '../../components/icons'
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
  evidenceId,
  expanded,
  onSelect,
}: {
  sourceId: string
  sourceRef: RqSourceRef | undefined
  evidenceId: string
  expanded: boolean
  onSelect: (sourceId: string) => void
}) {
  if (!sourceRef) {
    return <span className="rq-source-badge rq-source-badge--unknown">{sourceId}</span>
  }
  const traceable = sourceRef.evidence.some((item) => item.quote.trim().length > 0)
  return (
    <button
      type="button"
      className={`rq-source-badge${traceable ? '' : ' rq-source-badge--untraceable'}`}
      aria-controls={evidenceId}
      aria-expanded={expanded}
      title={traceable ? undefined : 'No traceable source quotation for this value'}
      onClick={() => onSelect(sourceId)}
    >
      {sourceId}
    </button>
  )
}

function StatementRow({
  statement,
  sourceRefs,
  questionNumber,
  expandedSourceId,
  onSourceSelect,
}: {
  statement: RqStatement
  sourceRefs: Record<string, RqSourceRef>
  questionNumber: number
  expandedSourceId: string | null
  onSourceSelect: (sourceId: string) => void
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
            evidenceId={`rq-${questionNumber}-evidence-${sourceId}`}
            expanded={expandedSourceId === sourceId}
            onSelect={onSourceSelect}
          />
        ))}
      </div>
    </li>
  )
}

function SourceEvidenceCard({
  sourceId,
  sourceRef,
  evidenceId,
  onClose,
  projectId,
}: {
  sourceId: string
  sourceRef: RqSourceRef
  evidenceId: string
  onClose: () => void
  projectId: string
}) {
  const sourceTypeLabel = sourceRef.sourceType === 'quality' ? 'Quality assessment' : 'Extraction'
  const traceableEvidence = sourceRef.evidence.filter((item) => item.quote.trim().length > 0)

  return (
    <article
      id={evidenceId}
      className="rq-evidence-card rq-evidence-card--expanded"
    >
      <header className="rq-evidence-card__header">
        <span className="rq-evidence-card__icon" aria-hidden="true"><IconFile /></span>
        <div>
          <strong>{sourceId}</strong>
          <span>{sourceRef.publicationTitle}</span>
        </div>
      </header>
      <div className="rq-evidence-card__details">
        <p><strong>Recorded value:</strong> {formatSourceValue(sourceRef.value)}</p>
        {traceableEvidence.length ? (
          <LlmEvidence
            evidence={traceableEvidence}
            projectId={projectId}
            publicationId={sourceRef.publicationId}
          />
        ) : (
          <p className="muted">No traceable source quotation for this value.</p>
        )}
      </div>
      <div className="rq-evidence-card__footer">
        <span className={`rq-evidence-tag rq-evidence-tag--${sourceRef.sourceType}`}>
          {sourceRef.label}
        </span>
        <span>{sourceTypeLabel}</span>
      </div>
      <button
        type="button"
        className="link-button rq-evidence-card__toggle"
        onClick={onClose}
      >
        Close evidence
      </button>
    </article>
  )
}

function ResearchQuestionCard({
  projectId,
  researchQuestionId,
  questionNumber,
}: {
  projectId: string
  researchQuestionId: string
  questionNumber: number
}) {
  const queryClient = useQueryClient()
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
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
  const questionLabel = `RQ${questionNumber}`
  const sourceEntries = run ? Object.entries(run.sourceRefs) : []
  const selectedSourceEntry = expandedSourceId
    ? sourceEntries.find(([sourceId]) => sourceId === expandedSourceId)
    : undefined

  return (
    <div className="rq-card">
      <div className="rq-card__header">
        <div className="rq-card__question">
          <span className="rq-card__number">{questionLabel}</span>
          <h3>{data.researchQuestionText}</h3>
        </div>
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
          {data.synthesisEnabled && data.isStale ? (
            <p className="stale-banner" role="status">
              This synthesis may be outdated — the underlying results have changed since it was
              generated.
            </p>
          ) : null}
          {run.status === 'failed' && run.error ? (
            <p className="error" role="alert">{run.error}</p>
          ) : null}
          <div className={`rq-card__layout${selectedSourceEntry ? '' : ' rq-card__layout--single'}`}>
            <section className="rq-synthesis" aria-label={`Synthesis for ${questionLabel}`}>
              <h4>Synthesis</h4>
              <p className="rq-synthesis__intro">
                Evidence-supported findings generated from the project&apos;s authoritative results.
              </p>
              <h5>Key findings</h5>
              {run.statements.length === 0 ? (
                <p className="muted">No supported statements could be generated from the current data.</p>
              ) : (
                <ul className="rq-statement-list">
                  {run.statements.map((statement, index) => (
                    <StatementRow
                      key={index}
                      statement={statement}
                      sourceRefs={run.sourceRefs}
                      questionNumber={questionNumber}
                      expandedSourceId={expandedSourceId}
                      onSourceSelect={(sourceId) => setExpandedSourceId((current) => (
                        current === sourceId ? null : sourceId
                      ))}
                    />
                  ))}
                </ul>
              )}
              {run.limitations.length > 0 ? (
                <div className="rq-limitations">
                  <h5>Limitations</h5>
                  <ul>
                    {run.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
                  </ul>
                </div>
              ) : null}
              {run.generatedAt ? (
                <p className="rq-card__generated">Generated {new Date(run.generatedAt).toLocaleDateString()}</p>
              ) : null}
            </section>
            {selectedSourceEntry ? (
              <aside className="rq-evidence-panel" aria-label={`Selected evidence ${selectedSourceEntry[0]}`}>
                <h4>Selected Evidence</h4>
                <SourceEvidenceCard
                  sourceId={selectedSourceEntry[0]}
                  sourceRef={selectedSourceEntry[1]}
                  evidenceId={`rq-${questionNumber}-evidence-${selectedSourceEntry[0]}`}
                  onClose={() => setExpandedSourceId(null)}
                  projectId={projectId}
                />
              </aside>
            ) : null}
          </div>
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
      {researchQuestions.map((question, index) => (
        <ResearchQuestionCard
          key={question.id}
          projectId={projectId}
          researchQuestionId={question.id}
          questionNumber={index + 1}
        />
      ))}
    </section>
  )
}
