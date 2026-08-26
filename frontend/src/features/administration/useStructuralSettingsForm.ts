// Shared state handling for the panels that edit a stage's *structural*
// review settings (extractors per publication, allocation mode, quality
// scoring mode/aggregation).
//
// Two defects this replaces, both of which these panels had independently:
//
// 1. **Seeding once per component instance.** Each panel seeded its local
//    fields from the server in an effect guarded by `useRef(false)`. That ref
//    survives a `projectId` prop change, so navigating from project A's
//    settings to project B's without unmounting left A's values on screen --
//    and an edit then saved A's stale configuration onto B. State here is
//    keyed by the project it was seeded from, so a different project always
//    reseeds.
//
// 2. **Autosaving each control independently.** Every keystroke fired its own
//    unordered PUT carrying the *other* fields' current local values, so
//    requests sent A -> B -> C could be applied C -> B and leave the project
//    holding an older configuration than the reviewer last chose -- with the
//    UI showing the newer one. These settings now save explicitly, one
//    request at a time, which also suits settings the backend can refuse
//    outright (409 `structural_setting_locked`): silently autosaving a change
//    that gets rejected is a worse story than an obvious Save button.
//
// The panel keeps ownership of its fields and layout; this hook owns "what is
// the draft, is it dirty, is it saving, and which controls are frozen".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { structuralLockFrom, type StructuralSetting } from '../../api/domainErrors'

export type StructuralLocks = Partial<Record<StructuralSetting, string>>

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

function shallowEqual<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as Array<keyof T>
  return keys.length === Object.keys(right).length
    && keys.every((key) => left[key] === right[key])
}

interface Options<Draft extends object, Config> {
  projectId: string
  /** TanStack query key prefix; `projectId` is appended. */
  queryKey: string
  /** Path relative to `/api/v1/projects/{projectId}`, e.g. `quality-config`. */
  resource: string
  /** The editable draft this config maps to. */
  toDraft: (config: Config) => Draft
}

export interface StructuralSettingsForm<Draft extends object> {
  isLoading: boolean
  loadError: Error | null
  /** `null` until the current project's configuration has loaded. */
  draft: Draft | null
  /** Merge a partial change into the draft. */
  change: (patch: Partial<Draft>) => void
  dirty: boolean
  status: SaveStatus
  /** Persist the draft. No-op when there is nothing to save. */
  submit: () => void
  /** Discard local edits and return to the loaded configuration. */
  revert: () => void
  saveError: Error | null
  /**
   * Settings the backend has refused as locked, mapped to its explanation.
   * Latched for as long as this project's panel is open: the server does not
   * publish lock state up front, so the first rejection is what the UI has to
   * learn from -- and the answer cannot change back while work exists.
   */
  locks: StructuralLocks
}

export function useStructuralSettingsForm<Draft extends object, Config>({
  projectId,
  queryKey,
  resource,
  toDraft,
}: Options<Draft, Config>): StructuralSettingsForm<Draft> {
  const queryClient = useQueryClient()
  const endpoint = `/api/v1/projects/${projectId}/${resource}`

  const config = useQuery({
    queryKey: [queryKey, projectId],
    queryFn: () => apiRequest<Config>(endpoint),
    enabled: Boolean(projectId),
  })

  // `loadedFor` is what makes the state project-scoped: any value seeded from
  // a different project is never shown and never saved.
  const [state, setState] = useState<{
    loadedFor: string
    baseline: Draft
    draft: Draft
  } | null>(null)
  const [locks, setLocks] = useState<StructuralLocks>({})

  useEffect(() => {
    setLocks({})
  }, [projectId])

  const data = config.data
  useEffect(() => {
    if (!data) {
      // A project switch with the new configuration still in flight: drop the
      // previous project's draft rather than leave it on screen.
      setState((current) => (current && current.loadedFor !== projectId ? null : current))
      return
    }
    const serverValue = toDraft(data)
    setState((current) => {
      if (
        current
        && current.loadedFor === projectId
        && shallowEqual(current.baseline, serverValue)
      ) {
        // Same project, server unchanged since we seeded: keep the reviewer's
        // in-progress edits.
        return current
      }
      return { loadedFor: projectId, baseline: serverValue, draft: serverValue }
    })
    // `toDraft` is a plain projection defined inline by callers; re-running on
    // its identity would reseed on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, projectId])

  const save = useMutation({
    mutationFn: (next: Draft) => apiRequest<Config>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(next),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [queryKey, projectId] }),
    onError: (error) => {
      const lock = structuralLockFrom(error)
      if (lock) {
        setLocks((current) => ({ ...current, [lock.setting]: lock.message }))
        // The rejected value must not linger in the form: restore what the
        // server actually holds so the frozen control shows the truth.
        setState((current) => (current ? { ...current, draft: current.baseline } : current))
      }
    },
  })

  const change = useCallback((patch: Partial<Draft>) => {
    save.reset()
    setState((current) => (
      current ? { ...current, draft: { ...current.draft, ...patch } } : current
    ))
    // `save` is a stable mutation object from TanStack Query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const revert = useCallback(() => {
    save.reset()
    setState((current) => (current ? { ...current, draft: current.baseline } : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const draft = state?.draft ?? null
  const dirty = Boolean(state) && !shallowEqual(state!.draft, state!.baseline)

  const status: SaveStatus = save.isPending
    ? 'saving'
    : save.isError
      ? 'error'
      : dirty
        ? 'dirty'
        : save.isSuccess
          ? 'saved'
          : 'idle'

  const submit = useCallback(() => {
    if (!draft || !dirty || save.isPending) return
    save.mutate(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, save.isPending])

  return {
    isLoading: config.isLoading,
    loadError: config.error,
    draft,
    change,
    dirty,
    status,
    submit,
    revert,
    saveError: save.error,
    locks,
  }
}
