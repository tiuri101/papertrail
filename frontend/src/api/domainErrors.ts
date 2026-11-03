// Reading the machine-readable half of the backend's error envelope.
//
// A handful of domain errors are not "show the message and give up" errors:
// the UI has to react to them (freeze a control, name the jobs to wait for,
// point at the stage the operation belongs in). Those all arrive as a 409
// with a stable `code` plus a `details` payload; this module is the single
// place that knows their shapes, so no component has to re-parse `details`
// or fall back to matching on prose.

import { ApiError } from './client'

export function apiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null
}

export function apiErrorCode(error: unknown): string | null {
  return apiError(error)?.code ?? null
}

function detailString(error: unknown, key: string): string | null {
  const value = apiError(error)?.details?.[key]
  return typeof value === 'string' ? value : null
}

function detailNumber(error: unknown, key: string): number | null {
  const value = apiError(error)?.details?.[key]
  return typeof value === 'number' ? value : null
}

function detailStrings(error: unknown, key: string): string[] {
  const value = apiError(error)?.details?.[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/* ------------------------------------------------------------------ */
/* structural_setting_locked                                          */
/* ------------------------------------------------------------------ */

// The settings a stage's generated work items are a direct function of. Once
// work exists the backend refuses to change them (409
// `structural_setting_locked`), so the UI freezes exactly the named control.
export type StructuralSetting =
  | 'requiredReviewers'
  | 'allocationMode'
  | 'mode'
  | 'aggregation'

const STRUCTURAL_SETTINGS: readonly StructuralSetting[] = [
  'requiredReviewers',
  'allocationMode',
  'mode',
  'aggregation',
]

export interface StructuralLock {
  setting: StructuralSetting
  stage: string | null
  message: string
}

export function structuralLockFrom(error: unknown): StructuralLock | null {
  if (apiErrorCode(error) !== 'structural_setting_locked') return null
  const setting = detailString(error, 'setting')
  if (!setting || !STRUCTURAL_SETTINGS.includes(setting as StructuralSetting)) return null
  return {
    setting: setting as StructuralSetting,
    stage: detailString(error, 'stage'),
    message: apiError(error)?.message ?? 'This setting can no longer be changed.',
  }
}

// Shown next to a frozen control, in place of letting the reviewer edit a
// value the backend will only reject again.
export const STRUCTURAL_LOCK_HINT = 'Cannot be changed after work has started.'

/* ------------------------------------------------------------------ */
/* project lifecycle conflicts                                        */
/* ------------------------------------------------------------------ */

const LIFECYCLE_OPERATION_LABELS: Record<string, string> = {
  delete: 'deleting the project',
  reset: 'resetting the project',
  move_back: 'moving the project back',
  undo_merge: 'undoing this merge',
  clone: 'copying the project',
}

// The stages a merge-reversal conflict can name (backend ProjectStage), with
// the punctuation the generic title-caser in features/lifecycle can't infer.
const STAGE_LABELS: Record<string, string> = {
  draft: 'Draft',
  duplicate_review: 'Duplicate Review',
  title_abstract_screening: 'Title/Abstract Screening',
  full_text_screening: 'Full-Text Screening',
  extraction_quality: 'Extraction & Quality',
  completed: 'Completed',
}

function humanizeStage(stage: string): string {
  return STAGE_LABELS[stage]
    ?? stage.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function humanizeJobType(jobType: string): string {
  return jobType.replace(/[._]/g, ' ')
}

/**
 * A specific, actionable sentence for the domain errors the destructive
 * project-lifecycle actions can fail with, or `null` when the error is not
 * one of them and the caller should fall back to `error.message`.
 */
export function lifecycleErrorMessage(error: unknown): string | null {
  const code = apiErrorCode(error)

  if (code === 'project_jobs_running') {
    const operation = detailString(error, 'operation')
    const count = detailNumber(error, 'runningJobCount') ?? 0
    const types = detailStrings(error, 'runningJobTypes').map(humanizeJobType)
    const what = operation ? LIFECYCLE_OPERATION_LABELS[operation] ?? operation : 'this operation'
    const jobs = count === 1 ? '1 background job is' : `${count} background jobs are`
    const detail = types.length ? ` (${types.join(', ')})` : ''
    return `${jobs} still running${detail}. Wait for ${types.length === 1 ? 'it' : 'them'} to finish before ${what}, then try again.`
  }

  if (code === 'merge_reversal_stage_locked') {
    const projectStage = detailString(error, 'projectStage')
    const requiredStage = detailString(error, 'requiredStage') ?? 'duplicate_review'
    const where = projectStage ? ` The project is currently in ${humanizeStage(projectStage)}.` : ''
    return `A merge can only be undone while the project is in ${humanizeStage(requiredStage)}.${where}`
      + ' Move the project back to that stage first.'
  }

  if (code === 'project_ownership_required') {
    return apiError(error)?.message
      ?? 'A project must always have an owner. Transfer ownership to another member first.'
  }

  return null
}

/** `lifecycleErrorMessage`, falling back to the raw message. */
export function describeError(error: unknown): string | null {
  if (!error) return null
  return lifecycleErrorMessage(error)
    ?? (error instanceof Error ? error.message : String(error))
}
