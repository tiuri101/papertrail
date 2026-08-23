import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button, IconButton } from '../../components/Button'
import { Card } from '../../components/Card'
import { cn } from '../../lib/cn'
import { toolbarClass } from '../../components/layoutStyles'
import { IconCheckCircle, IconDownload, IconPlus } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import type { QualityConfig } from '../quality/types'
import { parseOptions, selectFieldTypes } from './fieldTypes'
import { FormFieldsEditor } from './FormFieldsEditor'
import { NewFieldDraftCard } from './NewFieldDraftCard'
import type { FormField, ReviewForm } from './types'
import { useFormFieldEditor } from './useFormFieldEditor'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { FieldLabel } from '../../components/FieldLabel'

type FormKind = 'extraction' | 'quality'

const KIND_TITLES: Record<FormKind, string> = {
  extraction: 'Extraction Form',
  quality: 'Quality Assessment Form',
}
const KIND_DEFAULT_NAMES: Record<FormKind, string> = {
  extraction: 'Extraction form',
  quality: 'Quality assessment form',
}
const KIND_TOOLTIPS: Record<FormKind, string> = {
  extraction: "The fields defined here are what reviewers fill in during data extraction. They're also the schema the optional LLM assistant uses when it suggests extracted values.",
  quality: 'The fields defined here are what reviewers fill in during quality assessment.',
}

/**
 * One project form (extraction or quality), always shown — no "create form" step: adding the
 * first field silently creates the form behind the scenes (or a template can be applied instead),
 * exactly like the project-setup wizard's equivalent step.
 */
export function FormKindSection({ projectId, kind, id }: { projectId: string; kind: FormKind; id?: string }) {
  const isQualityForm = kind === 'quality'
  const queryClient = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')

  const forms = useQuery({
    queryKey: ['forms', projectId],
    queryFn: () => apiRequest<ReviewForm[]>(`/api/v1/projects/${projectId}/forms`),
  })
  const templates = useQuery({
    queryKey: ['form-templates'],
    queryFn: () => apiRequest<ReviewForm[]>('/api/v1/form-templates'),
  })
  const qualityConfig = useQuery({
    queryKey: ['quality-config', projectId],
    queryFn: () => apiRequest<QualityConfig>(`/api/v1/projects/${projectId}/quality-config`),
    enabled: isQualityForm,
  })

  const existingForm = forms.data?.find((form) => !form.isTemplate && form.kind === kind)
  const templatesForKind = (templates.data ?? []).filter((template) => template.kind === kind)

  const createForm = useMutation({
    mutationFn: (fromTemplateId?: string) => apiRequest<ReviewForm>(
      `/api/v1/projects/${projectId}/forms`,
      {
        method: 'POST',
        body: JSON.stringify({ name: KIND_DEFAULT_NAMES[kind], kind, templateId: fromTemplateId || undefined }),
      },
    ),
    onSuccess: () => {
      setTemplateId('')
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const renameForm = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(`/api/v1/forms/${existingForm!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nameDraft }),
    }),
    onSuccess: () => {
      setRenaming(false)
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const saveAsTemplate = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(
      `/api/v1/forms/${existingForm!.id}/save-as-template`,
      { method: 'POST', body: JSON.stringify({ name: templateName || undefined }) },
    ),
    onSuccess: () => {
      setTemplateName('')
      queryClient.invalidateQueries({ queryKey: ['form-templates'] })
    },
  })

  // Only relevant before the form exists: adding the very first field creates the form and the
  // field together in one action, so there's never a separate "create a form" step to click
  // through first.
  const {
    fieldLabel, setFieldLabel, fieldType, setFieldType, required, setRequired,
    optionsText, setOptionsText, ratingMin, setRatingMin, ratingMax, setRatingMax,
    weight, setWeight, optionScores, setOptionScores, trueScore, setTrueScore,
    falseScore, setFalseScore, addingField, setAddingField,
    resetNewField,
  } = useFormFieldEditor(undefined, () => {})
  const showOptions = selectFieldTypes.has(fieldType)
  const showRatingScale = fieldType === 'rating'
  const options = parseOptions(optionsText)
  const addFirstField = useMutation({
    mutationFn: async () => {
      const form = await apiRequest<ReviewForm>(`/api/v1/projects/${projectId}/forms`, {
        method: 'POST',
        body: JSON.stringify({ name: KIND_DEFAULT_NAMES[kind], kind }),
      })
      await apiRequest<FormField>(`/api/v1/forms/${form.id}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          label: fieldLabel,
          fieldType,
          required,
          options: showOptions ? options : showRatingScale ? [ratingMin, ratingMax] : [],
          scoring: {},
        }),
      })
      return form
    },
    onSuccess: () => {
      resetNewField()
      setAddingField(false)
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })

  const mutationError = forms.error ?? createForm.error ?? renameForm.error ?? saveAsTemplate.error ?? addFirstField.error

  // Data extraction is a mandatory pipeline step, so an empty extraction form always warns.
  // Quality assessment is optional, so an empty quality form only warns when quality assessment
  // is actually turned on for this project — otherwise reviewers were never going to see it.
  const showEmptyWarning = isQualityForm ? Boolean(qualityConfig.data?.enabled) : true
  const emptyWarning = showEmptyWarning ? (
    <InfoBox tone="warning" icon={isQualityForm ? <IconCheckCircle /> : <IconDownload />}>
      <p>
        {isQualityForm
          ? 'This form has no fields yet. Quality assessment is enabled for this project, so reviewers won’t be able to submit one until at least one field exists.'
          : 'This form has no fields yet. Data extraction is a required pipeline step, so reviewers won’t be able to submit one until at least one field exists.'}
      </p>
    </InfoBox>
  ) : null

  return (
    <Card id={id} className="form-kind-section">
      <h2 className="inline-flex items-center gap-2 [&_svg]:size-5 [&_svg]:fill-current">
        {isQualityForm ? <IconCheckCircle /> : <IconDownload />}
        {KIND_TITLES[kind]}
      </h2>
      <InfoBox icon={isQualityForm ? <IconCheckCircle /> : <IconDownload />}>
        <p>
          {KIND_TOOLTIPS[kind]}
        </p>
      </InfoBox>
      {mutationError ? <p className="text-danger" role="alert">{mutationError.message}</p> : null}
      {existingForm ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {renaming ? (
              <form
                className={cn(toolbarClass, 'my-0!')}
                onSubmit={(event) => { event.preventDefault(); renameForm.mutate() }}
              >
                <FieldLabel>
                  Name
                  <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} required />
                </FieldLabel>
                <Button type="submit" variant="secondary" size="sm" loading={renameForm.isPending}>Save Name</Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
              </form>
            ) : (
              <>
                <h3 className="m-0">{existingForm.name}</h3>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => { setNameDraft(existingForm.name); setRenaming(true) }}
                >
                  Rename
                </Button>
              </>
            )}
          </div>
          <FormFieldsEditor
            formId={existingForm.id}
            isQualityForm={isQualityForm}
            readOnly={false}
            emptyState={emptyWarning}
          />
          <div className={toolbarClass}>
            <form
              className="inline-flex flex-wrap items-center gap-2"
              onSubmit={(event) => { event.preventDefault(); saveAsTemplate.mutate() }}
            >
              <label className="sr-only" htmlFor={`${kind}-save-as-template-name`}>Template name</label>
              <Input
                id={`${kind}-save-as-template-name`}
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder={`Save as template… (default: "${existingForm.name}")`}
              />
              <Button type="submit" variant="secondary" size="sm" loading={saveAsTemplate.isPending}>
                <IconCheckCircle />Save as Template
              </Button>
            </form>
            {saveAsTemplate.isSuccess ? <span className="text-text-muted text-sm">Template saved.</span> : null}
          </div>
        </>
      ) : (
        <>
          {emptyWarning}
          {templatesForKind.length ? (
            <FieldLabel>
              Start from a template
              <Select
                value={templateId}
                onChange={(event) => {
                  setTemplateId(event.target.value)
                  if (event.target.value) createForm.mutate(event.target.value)
                }}
                disabled={createForm.isPending}
              >
                <option value="">Choose a template…</option>
                {templatesForKind.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </Select>
            </FieldLabel>
          ) : null}
          <div className="llm-schema-fields form-editor-fields">
            {addingField ? (
              <NewFieldDraftCard
                fieldLabel={fieldLabel}
                fieldType={fieldType}
                required={required}
                optionsText={optionsText}
                ratingMin={ratingMin}
                ratingMax={ratingMax}
                weight={weight}
                optionScores={optionScores}
                trueScore={trueScore}
                falseScore={falseScore}
                isQualityForm={isQualityForm}
                showOptions={showOptions}
                showRatingScale={showRatingScale}
                options={options}
                onFieldLabelChange={setFieldLabel}
                onFieldTypeChange={setFieldType}
                onRequiredChange={setRequired}
                onOptionsTextChange={setOptionsText}
                onRatingMinChange={setRatingMin}
                onRatingMaxChange={setRatingMax}
                onWeightChange={setWeight}
                onOptionScoreChange={(option, value) => setOptionScores((current) => ({ ...current, [option]: value }))}
                onTrueScoreChange={setTrueScore}
                onFalseScoreChange={setFalseScore}
                onSubmit={() => addFirstField.mutate()}
                onCancel={() => { addFirstField.reset(); resetNewField(); setAddingField(false) }}
                saving={addFirstField.isPending}
              />
            ) : (
              <IconButton
                type="button"
                size="sm"
                variant="secondary"
                className="!size-[30px] !min-h-[30px] !min-w-[30px] justify-self-start rounded-full"
                aria-label="Add form field"
                title="Add form field"
                onClick={() => { addFirstField.reset(); resetNewField(); setAddingField(true) }}
              >
                <IconPlus />
              </IconButton>
            )}
          </div>
        </>
      )}
    </Card>
  )
}
