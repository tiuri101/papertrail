import { cn } from '../../lib/cn'

export const llmPanelClass = 'my-4 rounded-xl border border-border bg-primary-container p-4'
export const llmPanelHeadingClass = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 [&_h3]:m-0'

export function llmPanelToneClass(tone?: 'match' | 'mismatch' | 'warning') {
  return cn(
    llmPanelClass,
    tone === 'match' && 'border-success shadow-[0_0_0_1px_var(--color-success)]',
    tone === 'mismatch' && 'border-danger shadow-[0_0_0_1px_var(--color-danger)]',
    tone === 'warning' && 'border-warning',
  )
}

export function llmValidationClass(assessment?: string) {
  return llmPanelToneClass(
    assessment === 'contradicted' || assessment === 'uncertain' ? 'warning' : undefined,
  )
}

export const llmSchemaFieldsClass = 'my-4 grid gap-3'
export const llmSchemaSummaryClass = 'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-2 p-4 marker:text-primary'
export const llmSchemaTitleClass = 'col-start-1 flex flex-wrap items-center gap-2'
export const llmSchemaMappingClass = 'col-start-1 text-sm text-text-secondary'
export const llmSchemaPreviewClass = 'col-start-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-secondary'
export const llmSchemaContentClass = 'grid gap-4 border-t border-border p-5'
export const llmSchemaToggleClass = 'relative w-fit [&>label]:flex [&>label]:items-center [&>label]:gap-2'

export function llmSchemaFieldClass({ dragging, dragOver, draft }: {
  dragging?: boolean
  dragOver?: boolean
  draft?: boolean
} = {}) {
  return cn(
    'overflow-hidden rounded-md border border-border bg-bg-elevated open:border-border-strong open:bg-surface-raised open:shadow-sm',
    dragging && 'opacity-55',
    dragOver && 'border-primary shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary)_18%,transparent)]',
    draft && 'border-primary bg-surface-raised shadow-sm',
  )
}
