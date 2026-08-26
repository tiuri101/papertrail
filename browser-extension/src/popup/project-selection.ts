import type { AgentProject } from '../papertrail/types'

/** Which project the capture dropdown should default to: the previously
 * remembered one if it's still among the agent's accessible projects,
 * otherwise the first project, otherwise none. Kept separate from popup.ts
 * (which has a top-level side effect on import) so it can be unit-tested
 * directly. */
export function resolveSelectedProjectId(
  projects: AgentProject[],
  rememberedId: string | null,
): string | null {
  if (rememberedId && projects.some((project) => project.id === rememberedId)) {
    return rememberedId
  }
  return projects[0]?.id ?? null
}
