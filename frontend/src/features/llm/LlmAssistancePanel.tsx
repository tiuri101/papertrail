import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { DragHandle } from '../../components/DragHandle'
import { InfoBox } from '../../components/InfoBox'
import { IconCheckCircle, IconChart, IconSettings, IconSparkle, IconTrash } from '../../components/icons'
import { InfoTooltip } from '../../components/Tooltip'
import { STAGES } from '../projects/StageProgress'

const stageColors = Object.fromEntries(STAGES.map((stage) => [stage.value, stage.color]))

function stageButtonStyle(stage: keyof typeof stageColors): CSSProperties {
  return { '--stage-color': stageColors[stage] } as CSSProperties
}

interface LlmSettings {
  enabled: boolean
  titleAbstractScreeningEnabled: boolean
  fullTextScreeningEnabled: boolean
  extractionValidationEnabled: boolean
  analysisNarrativeEnabled: boolean
  installationEnabled: boolean
  provider: string
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

export interface LlmAssistancePanelHandle {
  finishSetup: () => Promise<void>
}

interface LlmAssistancePanelProps {
  projectId: string
  showProcessingStatus?: boolean
  onDirtyChange?: (dirty: boolean) => void
  setupMode?: boolean
}

export const LlmAssistancePanel = forwardRef<LlmAssistancePanelHandle, LlmAssistancePanelProps>(function LlmAssistancePanel({
  projectId,
  showProcessingStatus = true,
  onDirtyChange,
  setupMode = false,
}, ref) {
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
  const [draggedFieldKey, setDraggedFieldKey] = useState<string | null>(null)
  const [dragOverFieldKey, setDragOverFieldKey] = useState<string | null>(null)
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
      'enabled' | 'titleAbstractScreeningEnabled' | 'fullTextScreeningEnabled' | 'extractionValidationEnabled' | 'analysisNarrativeEnabled'>>) => apiRequest(
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
  const finishSetup = useMutation({
    mutationFn: async () => {
      const currentSchema = schema.data?.schema
      if (!currentSchema) return

      const savedFields = currentSchema.fields
      let schemaToPublish = currentSchema
      if (JSON.stringify(fields) !== JSON.stringify(savedFields)) {
        schemaToPublish = await apiRequest<LlmSchema>(
          `/api/v1/projects/${projectId}/llm/schema/${currentSchema.id}`,
          { method: 'PUT', body: JSON.stringify({ fields }) },
        )
      }
      if (schemaToPublish.status === 'draft') {
        await apiRequest<LlmSchema>(
          `/api/v1/projects/${projectId}/llm/schema/${schemaToPublish.id}/publish`,
          { method: 'POST' },
        )
      }
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
  const moveFieldTo = (stableKey: string, targetStableKey: string) => setFields((current) => {
    const sourceIndex = current.findIndex((field) => field.stableKey === stableKey)
    const targetIndex = current.findIndex((field) => field.stableKey === targetStableKey)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current
    const next = [...current]
    const [movedField] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, movedField)
    return next.map((field, position) => ({ ...field, position }))
  })
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

  useImperativeHandle(ref, () => ({
    finishSetup: () => finishSetup.mutateAsync(),
  }), [finishSetup])

  const capabilitiesError = toggle.error
  const schemaError = initialize.error ?? save.error ?? publish.error ?? finishSetup.error
  const processingError = reanalyze.error
  const currentSchema = schema.data?.schema
  return (
    <>
    {settings.data && !settings.data.installationEnabled ? (
      <InfoBox icon={<IconSettings />} tone="danger" alert>
        <p>
          LLM support is currently disabled for this Papertrail installation. An administrator
          must enable it from Global Settings before AI assistance features work here.
        </p>
      </InfoBox>
    ) : null}
    <CollapsibleSection id="section-llm-installation" title="LLM Installation" icon={<IconSettings />}>
      <InfoBox icon={<IconSettings />}>
        <p>
          The exact large language model and context length Papertrail is currently using for generating LLM-based suggestions.
        </p>
      </InfoBox>
      {settings.data ? (
        <dl className="detail-list">
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
    </CollapsibleSection>

    <CollapsibleSection id="section-llm-capabilities" title="LLM Capabilities" icon={<IconCheckCircle />}>
      <InfoBox icon={<IconCheckCircle />}>
        <p>
          Turn LLM suggestions on or off for different tasks across the different reviewing stages independently.
        </p>
      </InfoBox>
      {settings.data ? (
        <fieldset>
          <legend className="subsection-heading">Stages</legend>
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
          <label>
            <input
              type="checkbox"
              checked={settings.data.analysisNarrativeEnabled}
              disabled={!settings.data.installationEnabled || toggle.isPending}
              onChange={(event) => toggle.mutate({ analysisNarrativeEnabled: event.target.checked })}
            />
            AI-generated interpretive analysis (stage-result narrative summaries and research-question synthesis)
          </label>
        </fieldset>
      ) : null}
      {capabilitiesError ? <p className="error" role="alert">{capabilitiesError.message}</p> : null}
    </CollapsibleSection>

    <CollapsibleSection id="section-llm-extraction-schema" title="LLM Extraction Schema" icon={<IconSparkle />}>
      <InfoBox icon={<IconSparkle />}>
        <p>
          Define the fields the LLM extracts alongside reviewers&apos; own answers. Map a field to
          an extraction question, or leave it as an LLM-only helper. Suggestions are never applied automatically.
        </p>
      </InfoBox>
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
            <details
              className={`llm-schema-field${draggedFieldKey === field.stableKey ? ' llm-schema-field--dragging' : ''}${dragOverFieldKey === field.stableKey ? ' llm-schema-field--drag-over' : ''}`}
              key={field.stableKey}
              data-field-sort-key={field.stableKey}
              onDragOver={(event) => {
                if (!draggedFieldKey) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDragOverFieldKey(field.stableKey)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const sourceKey = draggedFieldKey || event.dataTransfer.getData('text/plain')
                if (sourceKey) moveFieldTo(sourceKey, field.stableKey)
                setDraggedFieldKey(null)
                setDragOverFieldKey(null)
              }}
            >
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
                <DragHandle
                  label={field.label || `Field ${index + 1}`}
                  index={index}
                  itemCount={fields.length}
                  disabled={fields.length < 2}
                  onMove={(targetIndex) => moveFieldTo(
                    field.stableKey,
                    fields[targetIndex].stableKey,
                  )}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', field.stableKey)
                    setDraggedFieldKey(field.stableKey)
                  }}
                  onDragEnd={() => {
                    setDraggedFieldKey(null)
                    setDragOverFieldKey(null)
                  }}
                  onPointerDragStart={() => setDraggedFieldKey(field.stableKey)}
                  onPointerDragOver={(targetKey) => setDragOverFieldKey(
                    targetKey === field.stableKey ? null : targetKey,
                  )}
                  onPointerDrop={(targetKey) => {
                    if (targetKey) moveFieldTo(field.stableKey, targetKey)
                    setDraggedFieldKey(null)
                    setDragOverFieldKey(null)
                  }}
                  onPointerDragCancel={() => {
                    setDraggedFieldKey(null)
                    setDragOverFieldKey(null)
                  }}
                />
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
              <div className="llm-schema-field__toggle-setting">
                <label>
                  <input
                    type="checkbox"
                    checked={field.evidenceRequired}
                    onChange={(event) => edit(index, { evidenceRequired: event.target.checked })}
                  />
                  Require evidence
                </label>
                <InfoTooltip
                  label="About requiring evidence"
                  text="Require the LLM to support a returned value with a quote from the publication. Papertrail verifies the quote against the cited PDF page and flags missing or unverifiable evidence."
                />
              </div>
              <div className="llm-schema-field__toggle-setting">
                <label>
                  <input
                    type="checkbox"
                    checked={field.allowInferred}
                    onChange={(event) => edit(index, { allowInferred: event.target.checked })}
                  />
                  Allow inferred values
                </label>
                <InfoTooltip
                  label="About inferred values"
                  text="Allow the LLM to derive a value from information in the paper when it is not stated directly. Inferred results are rejected when this is turned off."
                />
              </div>
              <label><input type="checkbox" checked={field.enabled} onChange={(event) => edit(index, { enabled: event.target.checked })} /> Enabled</label>
              <Button type="button" variant="destructive" onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>
                <IconTrash />
                Remove field
              </Button>
              </div>
            </details>
            )
          })}
          </div>
          <div className="toolbar">
            <Button type="button" variant="secondary" onClick={addHelper}>Add helper field</Button>
            {!setupMode ? (
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>Save draft</Button>
            ) : null}
          </div>
          {!setupMode ? (
            <div className="toolbar">
              <Button
                type="button"
                variant="success"
                onClick={() => publish.mutate()}
                disabled={publish.isPending || currentSchema.status !== 'draft'}
              >
                <IconCheckCircle />
                Publish version
              </Button>
            </div>
          ) : null}
          </>
        )}
      {schemaError ? <p className="error" role="alert">{schemaError.message}</p> : null}
    </CollapsibleSection>

    {showProcessingStatus ? (
      <CollapsibleSection id="section-llm-processing-status" title="Processing Status" icon={<IconChart />}>
        <InfoBox icon={<IconChart />}>
          <p>
            Live counts of publications processed by the LLM for this project. Re-run a stage
            after changing its schema or settings so results reflect the latest configuration.
          </p>
        </InfoBox>
          {overview.data ? (
            <>
              <div className="llm-processing-status">
                <table className="table-compact table-narrow llm-processing-status__table">
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><th scope="row">Eligible for processing</th><td>{overview.data.overview.eligible}</td></tr>
                    <tr><th scope="row">Missing PDF</th><td>{overview.data.overview.missingPdf}</td></tr>
                    <tr><th scope="row">Outdated schema</th><td>{overview.data.overview.outdatedSchema}</td></tr>
                    <tr><th scope="row">Ready</th><td>{overview.data.counts.completed ?? 0}</td></tr>
                    <tr><th scope="row">Processing</th><td>{overview.data.counts.processing ?? 0}</td></tr>
                    <tr><th scope="row">Queued</th><td>{overview.data.counts.pending ?? 0}</td></tr>
                    <tr><th scope="row">Failed</th><td>{overview.data.counts.failed ?? 0}</td></tr>
                    <tr><th scope="row">Average prompt tokens</th><td>{Math.round(overview.data.statistics.averagePromptTokens ?? 0)}</td></tr>
                    <tr><th scope="row">Average generated tokens</th><td>{Math.round(overview.data.statistics.averageGeneratedTokens ?? 0)}</td></tr>
                  </tbody>
                </table>
                <div className="llm-rerun-actions">
                  <button
                    type="button"
                    className="llm-stage-button"
                    style={stageButtonStyle('title_abstract_screening')}
                    onClick={() => reanalyze.mutate('title_abstract_screening')}
                    disabled={reanalyze.isPending || !settings.data?.titleAbstractScreeningEnabled}
                  >
                    Re-Run LLM Title/Abstract Screening
                  </button>
                  <button
                    type="button"
                    className="llm-stage-button"
                    style={stageButtonStyle('full_text_screening')}
                    onClick={() => reanalyze.mutate('full_text_screening')}
                    disabled={reanalyze.isPending || !settings.data?.fullTextScreeningEnabled}
                  >
                    Re-Run LLM Full-Text Screening
                  </button>
                  <button
                    type="button"
                    className="llm-stage-button"
                    style={stageButtonStyle('extraction_quality')}
                    onClick={() => reanalyze.mutate('data_extraction')}
                    disabled={reanalyze.isPending || !settings.data?.enabled}
                  >
                    Re-Run LLM Data Extraction
                  </button>
                  <button
                    type="button"
                    className="llm-stage-button"
                    style={stageButtonStyle('extraction_quality')}
                    onClick={() => reanalyze.mutate('extraction_validation')}
                    disabled={reanalyze.isPending || !settings.data?.extractionValidationEnabled}
                  >
                    Re-Run LLM Human Extraction Validation
                  </button>
                </div>
              </div>
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
            </>
          ) : <p>Loading processing status…</p>}
          {processingError ? <p className="error" role="alert">{processingError.message}</p> : null}
      </CollapsibleSection>
    ) : null}
    </>
  )
})
