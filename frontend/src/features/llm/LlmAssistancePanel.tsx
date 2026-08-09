import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconCheckCircle, IconTrash } from '../../components/icons'

interface LlmSettings {
  enabled: boolean
  titleAbstractScreeningEnabled: boolean
  fullTextScreeningEnabled: boolean
  extractionValidationEnabled: boolean
  installationEnabled: boolean
  provider: string
  endpoint: string | null
  model: string | null
  contextLength: number
  currentSchemaVersionId: string | null
}

interface ExtractionField {
  stableKey: string
  label: string
  fieldType: string
  options: string[]
}

export interface LlmSchemaField {
  id?: string
  stableKey: string
  label: string
  instruction: string
  fieldType: string
  mappedExtractionFieldKey: string | null
  options: string[]
  evidenceRequired: boolean
  allowInferred: boolean
  enabled: boolean
  position: number
  mappingState?: string
}

interface LlmSchema {
  id: string
  versionNumber: number
  status: string
  fields: LlmSchemaField[]
}

interface SchemaPayload {
  schema: LlmSchema | null
  extractionFields: ExtractionField[]
}

interface RunOverview {
  total: number
  counts: Record<string, number>
  statistics: {
    averageDuration: number | null
    averagePromptTokens: number | null
    averageGeneratedTokens: number | null
  }
  overview: { eligible: number; missingPdf: number; outdatedSchema: number }
  runs: Array<{ id: string; status: string; model: string; error: string | null; outdated: boolean }>
}

const FIELD_TYPES = [
  'short_text', 'long_text', 'number', 'checkbox', 'single_select',
  'multiple_select', 'date', 'url', 'rating',
]

export function LlmAssistancePanel({
  projectId,
  showProcessingStatus = true,
  onDirtyChange,
}: {
  projectId: string
  showProcessingStatus?: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['llm-settings', projectId],
    queryFn: () => apiRequest<LlmSettings>(`/api/v1/projects/${projectId}/llm/settings`),
  })
  const schema = useQuery({
    queryKey: ['llm-schema', projectId],
    queryFn: () => apiRequest<SchemaPayload>(`/api/v1/projects/${projectId}/llm/schema`),
  })
  const overview = useQuery({
    queryKey: ['llm-runs', projectId],
    queryFn: () => apiRequest<RunOverview>(`/api/v1/projects/${projectId}/llm/runs?limit=10`),
    enabled: showProcessingStatus,
  })
  const [fields, setFields] = useState<LlmSchemaField[]>([])
  const [connection, setConnection] = useState<{ message: string; ok: boolean } | null>(null)

  useEffect(() => setFields(schema.data?.schema?.fields ?? []), [schema.data?.schema])

  useEffect(() => {
    const saved = schema.data?.schema?.fields ?? []
    onDirtyChange?.(JSON.stringify(fields) !== JSON.stringify(saved))
  }, [fields, schema.data?.schema, onDirtyChange])

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['llm-schema', projectId] })
    await queryClient.invalidateQueries({ queryKey: ['llm-settings', projectId] })
    await queryClient.invalidateQueries({ queryKey: ['llm-runs', projectId] })
  }
  const toggle = useMutation({
    mutationFn: (patch: Partial<Pick<LlmSettings,
      'enabled' | 'titleAbstractScreeningEnabled' | 'fullTextScreeningEnabled' | 'extractionValidationEnabled'>>) => apiRequest(
      `/api/v1/projects/${projectId}/llm/settings`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
    onSuccess: refresh,
  })
  const test = useMutation({
    mutationFn: () => apiRequest<{ available: boolean; modelAvailable: boolean; error?: string }>(
      `/api/v1/projects/${projectId}/llm/test`, { method: 'POST' },
    ),
    onSuccess: (result) => setConnection({
      ok: result.available && result.modelAvailable,
      message: result.available
        ? result.modelAvailable ? 'Available; configured model found.' : 'Available; configured model not found.'
        : result.error ?? 'Unavailable',
    }),
    onError: (mutationError) => setConnection({
      ok: false,
      message: mutationError instanceof Error ? mutationError.message : 'Unable to test the connection.',
    }),
  })
  const initialize = useMutation({
    mutationFn: () => apiRequest<LlmSchema>(
      `/api/v1/projects/${projectId}/llm/schema/from-extraction-form`, { method: 'POST' },
    ),
    onSuccess: refresh,
  })
  const save = useMutation({
    mutationFn: () => {
      if (!schema.data?.schema) throw new Error('No LLM schema')
      return apiRequest<LlmSchema>(
        `/api/v1/projects/${projectId}/llm/schema/${schema.data.schema.id}`,
        { method: 'PUT', body: JSON.stringify({ fields }) },
      )
    },
    onSuccess: refresh,
  })
  const publish = useMutation({
    mutationFn: () => {
      if (!schema.data?.schema) throw new Error('No LLM schema')
      return apiRequest<LlmSchema>(
        `/api/v1/projects/${projectId}/llm/schema/${schema.data.schema.id}/publish`,
        { method: 'POST' },
      )
    },
    onSuccess: refresh,
  })
  const reanalyze = useMutation({
    mutationFn: (taskType: 'title_abstract_screening' | 'full_text_screening' | 'data_extraction' | 'extraction_validation') => apiRequest(
      `/api/v1/projects/${projectId}/llm/runs/reanalyze`,
      { method: 'POST', body: JSON.stringify({ taskType }) },
    ),
    onSuccess: refresh,
  })

  const edit = (index: number, patch: Partial<LlmSchemaField>) => setFields((current) => (
    current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field)
  ))
  const addHelper = () => setFields((current) => [...current, {
    stableKey: crypto.randomUUID(),
    label: 'Paper summary',
    instruction: 'Summarize the paper briefly using only information stated in the paper.',
    fieldType: 'long_text',
    mappedExtractionFieldKey: null,
    options: [],
    evidenceRequired: true,
    allowInferred: false,
    enabled: true,
    position: current.length,
  }])

  const error = toggle.error ?? initialize.error ?? save.error
    ?? publish.error ?? reanalyze.error
  const currentSchema = schema.data?.schema
  return (
    <CollapsibleSection id="section-llm-assistance" title="LLM Assistance">
      <p className="muted">
        Suggestions come from the configured external Ollama service. Reviewers remain responsible
        for every submitted extraction value.
      </p>
      {settings.data ? (
        <dl className="detail-list">
          <dt>Installation enabled</dt><dd>{settings.data.installationEnabled ? 'Yes' : 'No'}</dd>
          <dt>Provider</dt><dd>{settings.data.provider}</dd>
          <dt>Endpoint</dt><dd>{settings.data.endpoint ?? 'Not configured'}</dd>
          <dt>Model</dt><dd>{settings.data.model ?? 'Not configured'}</dd>
          <dt>Context length</dt><dd>{settings.data.contextLength.toLocaleString()}</dd>
        </dl>
      ) : null}
      <div className="toolbar">
        <button type="button" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test Connection'}
        </button>
      </div>
      {connection ? (
        <p className={connection.ok ? 'success' : 'error'} role={connection.ok ? 'status' : 'alert'}>
          {connection.message}
        </p>
      ) : null}
      {settings.data ? (
        <fieldset>
          <legend className="subsection-heading">LLM capabilities</legend>
          <label>
            <input
              type="checkbox"
              checked={settings.data.titleAbstractScreeningEnabled}
              disabled={!settings.data.installationEnabled || toggle.isPending}
              onChange={(event) => toggle.mutate({ titleAbstractScreeningEnabled: event.target.checked })}
            />
            Title/abstract screening suggestions (revealed only after reviewer decision)
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.data.fullTextScreeningEnabled}
              disabled={!settings.data.installationEnabled || toggle.isPending}
              onChange={(event) => toggle.mutate({ fullTextScreeningEnabled: event.target.checked })}
            />
            Full-text screening assistance
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.data.enabled}
              disabled={!settings.data.installationEnabled || toggle.isPending}
              onChange={(event) => toggle.mutate({ enabled: event.target.checked })}
            />
            LLM data extraction
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.data.extractionValidationEnabled}
              disabled={!settings.data.installationEnabled || toggle.isPending}
              onChange={(event) => toggle.mutate({ extractionValidationEnabled: event.target.checked })}
            />
            Validate completed human extractions automatically
          </label>
        </fieldset>
      ) : null}

      <h3>LLM Extraction Schema</h3>
      {!currentSchema ? (
        <button type="button" onClick={() => initialize.mutate()} disabled={initialize.isPending}>
          Create LLM schema from extraction form
        </button>
      ) : (
        <>
          <p>Version {currentSchema.versionNumber} · {currentSchema.status}</p>
          <div className="llm-schema-fields">
          {fields.map((field, index) => {
            const mappedField = schema.data?.extractionFields.find(
              (item) => item.stableKey === field.mappedExtractionFieldKey,
            )
            return (
            <details className="llm-schema-field" key={field.stableKey}>
              <summary className="llm-schema-field__summary">
                <span className="llm-schema-field__title">
                  <strong>{field.label || `Field ${index + 1}`}</strong>
                  <span className="status-badge">{field.fieldType.replaceAll('_', ' ')}</span>
                  {!field.enabled ? <span className="status-badge">Disabled</span> : null}
                </span>
                <span className="llm-schema-field__mapping">
                  {mappedField ? `Maps to ${mappedField.label}` : 'LLM-only helper field'}
                </span>
                <span className="llm-schema-field__preview">
                  {field.instruction || 'No extraction instruction provided.'}
                </span>
              </summary>
              <div className="llm-schema-field__content">
              <label>Label
                <input value={field.label} onChange={(event) => edit(index, { label: event.target.value })} />
              </label>
              <label>Extraction instruction
                <textarea value={field.instruction} onChange={(event) => edit(index, { instruction: event.target.value })} />
              </label>
              <label>Output type
                <select value={field.fieldType} onChange={(event) => edit(index, { fieldType: event.target.value })}>
                  {FIELD_TYPES.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}
                </select>
              </label>
              <label>Mapped extraction field
                <select
                  value={field.mappedExtractionFieldKey ?? ''}
                  onChange={(event) => {
                    const target = schema.data?.extractionFields.find((item) => item.stableKey === event.target.value)
                    edit(index, {
                      mappedExtractionFieldKey: target?.stableKey ?? null,
                      fieldType: target?.fieldType ?? field.fieldType,
                      options: target?.options ?? field.options,
                    })
                  }}
                >
                  <option value="">LLM-only helper field</option>
                  {schema.data?.extractionFields.map((target) => (
                    <option key={target.stableKey} value={target.stableKey}>{target.label}</option>
                  ))}
                </select>
              </label>
              {!field.mappedExtractionFieldKey && ['single_select', 'multiple_select', 'rating'].includes(field.fieldType) ? (
                <label>Allowed values or rating bounds (comma-separated)
                  <input
                    value={field.options.join(', ')}
                    onChange={(event) => edit(index, {
                      options: event.target.value.split(',').map((value) => value.trim()).filter(Boolean),
                    })}
                  />
                </label>
              ) : null}
              {field.mappingState && !['active', 'helper'].includes(field.mappingState) ? (
                <p className="error">Mapping is {field.mappingState}; resolve it before publishing.</p>
              ) : null}
              <label><input type="checkbox" checked={field.evidenceRequired} onChange={(event) => edit(index, { evidenceRequired: event.target.checked })} /> Require evidence</label>
              <label><input type="checkbox" checked={field.allowInferred} onChange={(event) => edit(index, { allowInferred: event.target.checked })} /> Allow inferred values</label>
              <label><input type="checkbox" checked={field.enabled} onChange={(event) => edit(index, { enabled: event.target.checked })} /> Enabled</label>
              <div className="toolbar">
                <button type="button" className="button-secondary" disabled={index === 0} onClick={() => setFields((current) => {
                  const next = [...current]
                  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                  return next
                })}>Move up</button>
                <button type="button" className="button-secondary" disabled={index === fields.length - 1} onClick={() => setFields((current) => {
                  const next = [...current]
                  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                  return next
                })}>Move down</button>
              </div>
              <button type="button" className="button-danger" onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>
                <IconTrash />
                Remove field
              </button>
              </div>
            </details>
            )
          })}
          </div>
          <div className="toolbar">
            <button type="button" className="button-secondary" onClick={addHelper}>Add helper field</button>
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save draft</button>
          </div>
          <div className="toolbar">
            <button
              type="button"
              className="button-success"
              onClick={() => publish.mutate()}
              disabled={publish.isPending || currentSchema.status !== 'draft'}
            >
              <IconCheckCircle />
              Publish version
            </button>
          </div>
        </>
      )}
      {error ? <p className="error" role="alert">{error.message}</p> : null}

      {showProcessingStatus ? (
        <>
          <h3>Processing status</h3>
          {overview.data ? (
            <>
              <dl className="detail-list">
                <dt>Eligible for processing</dt><dd>{overview.data.overview.eligible}</dd>
                <dt>Missing PDF</dt><dd>{overview.data.overview.missingPdf}</dd>
                <dt>Outdated schema</dt><dd>{overview.data.overview.outdatedSchema}</dd>
                <dt>Ready</dt><dd>{overview.data.counts.completed ?? 0}</dd>
                <dt>Processing</dt><dd>{overview.data.counts.processing ?? 0}</dd>
                <dt>Queued</dt><dd>{overview.data.counts.pending ?? 0}</dd>
                <dt>Failed</dt><dd>{overview.data.counts.failed ?? 0}</dd>
                <dt>Average prompt tokens</dt><dd>{Math.round(overview.data.statistics.averagePromptTokens ?? 0)}</dd>
                <dt>Average generated tokens</dt><dd>{Math.round(overview.data.statistics.averageGeneratedTokens ?? 0)}</dd>
              </dl>
              {overview.data.runs.some((run) => run.outdated) ? <p>Some results use an older schema version.</p> : null}
              {overview.data.runs.some((run) => run.status === 'failed') ? (
                <details>
                  <summary>Recent failures</summary>
                  <ul>
                    {overview.data.runs.filter((run) => run.status === 'failed').map((run) => (
                      <li key={run.id}>{run.model}: {run.error ?? 'Unknown processing error'}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <div className="toolbar">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => reanalyze.mutate('title_abstract_screening')}
                  disabled={reanalyze.isPending || !settings.data?.titleAbstractScreeningEnabled}
                >
                  Re-Run LLM Title/Abstract Screening
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => reanalyze.mutate('full_text_screening')}
                  disabled={reanalyze.isPending || !settings.data?.fullTextScreeningEnabled}
                >
                  Re-Run LLM Full-Text Screening
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => reanalyze.mutate('data_extraction')}
                  disabled={reanalyze.isPending || !settings.data?.enabled}
                >
                  Re-Run LLM Data Extraction
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => reanalyze.mutate('extraction_validation')}
                  disabled={reanalyze.isPending || !settings.data?.extractionValidationEnabled}
                >
                  Re-Run LLM Human Extraction Validation
                </button>
              </div>
            </>
          ) : <p>Loading processing status…</p>}
        </>
      ) : null}
    </CollapsibleSection>
  )
}
