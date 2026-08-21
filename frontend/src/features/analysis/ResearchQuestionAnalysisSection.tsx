import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
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
    return <span className="inline-flex cursor-default items-center rounded-full border border-primary/35 bg-primary-container px-[9px] py-[3px] text-[0.72rem] font-bold leading-[1.3] text-primary opacity-60">{sourceId}</span>
  }
  const traceable = sourceRef.evidence.some((item) => item.quote.trim().length > 0)
  return (
    <button
      type="button"
      className={`inline-flex h-auto min-h-0 w-auto min-w-0 cursor-pointer items-center rounded-full border px-[9px] py-[3px] text-[0.72rem] font-bold leading-[1.3] shadow-none ${traceable ? 'border-primary/35 bg-primary-container text-primary hover:border-primary hover:bg-primary-container-hover aria-expanded:border-primary aria-expanded:bg-primary-container-hover' : 'border-dashed border-warning/55 bg-warning-container text-warning hover:border-warning aria-expanded:border-warning'}`}
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
    <li className="pl-1 text-text-secondary marker:text-primary">
      <p>{statement.claim}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
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
      className="min-w-0 rounded-md border border-primary/50 bg-surface-raised p-4 shadow-[0_0_0_2px_var(--color-primary-container)] transition-[border-color,box-shadow] duration-150"
    >
      <header className="flex items-center gap-2">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-container text-primary [&_svg]:size-3.5 [&_svg]:fill-current" aria-hidden="true"><IconFile /></span>
        <div className="grid min-w-0 gap-0.5 [&>strong]:text-[0.78rem] [&>strong]:text-text [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap [&>span]:text-xs [&>span]:text-text-muted">
          <strong>{sourceId}</strong>
          <span>{sourceRef.publicationTitle}</span>
        </div>
      </header>
      <div className="mt-3">
        <p><strong>Recorded value:</strong> {formatSourceValue(sourceRef.value)}</p>
        {traceableEvidence.length ? (
          <LlmEvidence
            evidence={traceableEvidence}
            projectId={projectId}
            publicationId={sourceRef.publicationId}
          />
        ) : (
          <p className="text-text-muted">No traceable source quotation for this value.</p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.72rem] text-text-muted">
        <span className={`max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-full px-2 py-[3px] font-bold ${sourceRef.sourceType === 'quality' ? 'bg-success-container text-success' : 'bg-primary-container text-primary'}`}>
          {sourceRef.label}
        </span>
        <span>{sourceTypeLabel}</span>
      </div>
      <Button
        type="button"
        variant="text"
        className="mt-2 min-h-0 text-[0.76rem]"
        onClick={onClose}
      >
        Close evidence
      </Button>
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
    return <p className="text-danger" role="alert">{analysis.error?.message ?? 'Could not load this research question.'}</p>
  }

  const data = analysis.data
  const run = data.latestRun
  const questionLabel = `RQ${questionNumber}`
  const sourceEntries = run ? Object.entries(run.sourceRefs) : []
  const selectedSourceEntry = expandedSourceId
    ? sourceEntries.find(([sourceId]) => sourceId === expandedSourceId)
    : undefined

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-sm first:mt-5">
      <div className="flex flex-col items-stretch justify-between gap-4 bg-[radial-gradient(circle_at_100%_0,var(--color-primary-container),transparent_18rem)] p-4 min-[601px]:flex-row min-[601px]:items-start min-[601px]:p-5 [&>button]:self-start">
        <div className="min-w-0">
          <span className="text-[0.78rem] font-extrabold uppercase tracking-[0.09em] text-primary">{questionLabel}</span>
          <h3>{data.researchQuestionText}</h3>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => regenerate.mutate()}
          disabled={isGenerating || !data.synthesisEnabled}
        >
          {isGenerating ? 'Generating…' : run ? 'Regenerate' : 'Generate synthesis'}
        </Button>
      </div>
      {!data.synthesisEnabled ? (
        <p className="text-text-muted">AI-generated interpretive analysis is disabled for this project.</p>
      ) : null}
      {regenerate.error ? <p className="text-danger" role="alert">{regenerate.error.message}</p> : null}
      {pendingJob?.status === 'failed' ? (
        <p className="text-danger" role="alert">
          Synthesis failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      {run ? (
        <>
          {data.synthesisEnabled && data.isStale ? (
            <p className="rounded-md border border-[color-mix(in_srgb,var(--color-warning)_35%,transparent)] bg-warning-container px-4 py-3 font-semibold text-warning" role="status">
              This synthesis may be outdated — the underlying results have changed since it was
              generated.
            </p>
          ) : null}
          {run.status === 'failed' && run.error ? (
            <p className="text-danger" role="alert">{run.error}</p>
          ) : null}
          <div className={`grid grid-cols-1 items-stretch border-t border-border ${selectedSourceEntry ? 'min-[901px]:grid-cols-[minmax(0,1.45fr)_minmax(280px,.85fr)]' : ''}`}>
            <section className="min-w-0 p-4 min-[601px]:p-5" aria-label={`Synthesis for ${questionLabel}`}>
              <h4>Synthesis</h4>
              <p className="mb-0 mt-2 max-w-[68ch] text-[0.9rem] leading-relaxed text-text-secondary">
                Evidence-supported findings generated from the project&apos;s authoritative results.
              </p>
              <h5>Key findings</h5>
              {run.statements.length === 0 ? (
                <p className="text-text-muted">No supported statements could be generated from the current data.</p>
              ) : (
                <ul className="mt-4 grid gap-4 pl-5">
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
                <div className="mt-6 rounded-md border border-border bg-bg-elevated p-4">
                  <h5>Limitations</h5>
                  <ul>
                    {run.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
                  </ul>
                </div>
              ) : null}
              {run.generatedAt ? (
                <p className="mb-0 mt-5 text-[0.78rem] text-text-muted">Generated {new Date(run.generatedAt).toLocaleDateString()}</p>
              ) : null}
            </section>
            {selectedSourceEntry ? (
              <aside className="min-w-0 border-t border-border bg-bg-elevated/65 p-4 min-[601px]:p-5 min-[901px]:border-l min-[901px]:border-t-0" aria-label={`Selected evidence ${selectedSourceEntry[0]}`}>
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
        <p className="text-text-muted">No synthesis generated yet.</p>
      )}
    </div>
  )
}

export function ResearchQuestionAnalysisSection({ projectId }: { projectId: string }) {
  const questions = useResearchQuestions(projectId)
  const researchQuestions = questions.data?.researchQuestions ?? []

  return (
    <Card as="section" id="section-analysis-research-question">
      <h2>Research Question Analysis</h2>
      <p className="text-text-muted">
        AI-generated synthesis of the authoritative extraction and quality-assessment results for
        each research question, with every statement traceable to specific source facts.
      </p>
      {questions.error ? <p className="text-danger" role="alert">{questions.error.message}</p> : null}
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
    </Card>
  )
}
