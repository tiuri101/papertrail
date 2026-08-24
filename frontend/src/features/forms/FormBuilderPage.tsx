import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { IconTrash } from '../../components/icons'
import { Page } from '../../components/Page'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { useProjectManageState } from '../../hooks/useCanManageProject'
import { useSession } from '../auth/sessionQuery'
import { StageEyebrow } from '../projects/StageEyebrow'
import { FormFieldsEditor } from './FormFieldsEditor'
import { FormKindSection } from './FormKindSection'
import type { ReviewForm } from './types'
import { Input } from '../../components/Input'
import { FieldLabel } from '../../components/FieldLabel'

const formBuilderSections = [
  { id: 'section-extraction-form', label: 'Extraction Form' },
  { id: 'section-quality-form', label: 'Quality Assessment Form' },
  { id: 'section-manage-templates', label: 'Manage Templates' },
]

function TemplateCard({ template, isAdmin, onRemove, removing }: {
  template: ReviewForm
  isAdmin: boolean
  onRemove: () => void
  removing: boolean
}) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(template.name)

  const renameTemplate = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(`/api/v1/forms/${template.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nameDraft }),
    }),
    onSuccess: () => {
      setRenaming(false)
      queryClient.invalidateQueries({ queryKey: ['form-templates'] })
    },
  })

  return (
    <li className="form-template-card">
      <div>
        <span className="form-template-card__kind">
          {template.kind === 'quality' ? 'Quality assessment' : 'Extraction'}
        </span>
        <h3>{template.name}</h3>
      </div>
      <div className="toolbar form-template-card__actions" data-template-actions>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setExpanded((current) => !current)}
        >
          {isAdmin ? 'Inspect & Edit' : 'Inspect'}
        </Button>
        {isAdmin ? (
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove Template"
            warning={`Remove the "${template.name}" template? Existing project forms created from it won't be affected.`}
            onConfirm={onRemove}
            disabled={removing}
            variant="danger"
            icon={<IconTrash />}
          />
        ) : null}
      </div>
      {expanded ? (
        <div className="form-editor-existing-form">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="form-editor-selection-type">Reusable template</span>
            {isAdmin ? (
              renaming ? (
                <form
                  className="inline-flex flex-wrap items-center gap-2"
                  onSubmit={(event) => { event.preventDefault(); renameTemplate.mutate() }}
                >
                  <FieldLabel>
                    Name
                    <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} required />
                  </FieldLabel>
                  <Button type="submit" variant="secondary" size="sm" loading={renameTemplate.isPending}>Save Name</Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setRenaming(false)}>Cancel</Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => { setNameDraft(template.name); setRenaming(true) }}
                >
                  Rename
                </Button>
              )
            ) : (
              <p className="muted">Templates are read-only unless you are an installation administrator.</p>
            )}
          </div>
          {renameTemplate.error ? <p className="error" role="alert">{renameTemplate.error.message}</p> : null}
          <FormFieldsEditor
            formId={template.id}
            isQualityForm={template.kind === 'quality'}
            readOnly={!isAdmin}
          />
        </div>
      ) : null}
    </li>
  )
}

export function FormBuilderPage() {
  const { projectId = '' } = useParams()
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  const session = useSession()
  const isAdmin = session.data?.user?.isAdmin ?? false
  useRegisterSectionItems(formBuilderSections)
  const queryClient = useQueryClient()

  const templates = useQuery({
    queryKey: ['form-templates'],
    queryFn: () => apiRequest<ReviewForm[]>('/api/v1/form-templates'),
    enabled: canManage,
  })
  const templateCatalog = templates.data?.filter((template) => template.isTemplate) ?? []

  const deleteTemplate = useMutation({
    mutationFn: (formId: string) => apiRequest<void>(`/api/v1/forms/${formId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-templates'] }),
  })

  if (canManageLoading) {
    return <Page><p>Loading…</p></Page>
  }
  if (!canManage) {
    return (
      <Page>
        <h1>Forms and Templates</h1>
        <p className="error" role="alert">
          Only the project owner or an administrator can manage forms and templates.
        </p>
      </Page>
    )
  }

  return (
    <Page>
      <StageEyebrow stage="draft" />
      <h1>Forms and Templates</h1>
      <p className="muted">
        This project's extraction and (optional) quality assessment forms, shown to reviewers
        during screening and data extraction.
      </p>
      <FormKindSection projectId={projectId} kind="extraction" id="section-extraction-form" />
      <FormKindSection projectId={projectId} kind="quality" id="section-quality-form" />
      <Card as="section" id="section-manage-templates" className="form-template-manager">
        <div className="form-template-manager__heading">
          <div>
            <h2>Manage Templates</h2>
          </div>
          <CountPill count={templateCatalog.length}>
            template{templateCatalog.length === 1 ? '' : 's'}
          </CountPill>
        </div>
        {templates.error ? <p className="error" role="alert">{templates.error.message}</p> : null}
        {templates.isLoading ? <p className="muted">Loading templates…</p> : null}
        {templateCatalog.length === 0 ? (
          <div className="empty-state form-template-manager__empty">
            <h3>No reusable templates yet</h3>
            <p>Save an extraction or quality form above as a template to build your catalog.</p>
          </div>
        ) : (
          <ul className="form-template-grid" aria-label="Form templates">
            {templateCatalog.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isAdmin={isAdmin}
                onRemove={() => deleteTemplate.mutate(template.id)}
                removing={deleteTemplate.isPending}
              />
            ))}
          </ul>
        )}
      </Card>
    </Page>
  )
}
