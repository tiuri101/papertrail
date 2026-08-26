import { describe, expect, it } from 'vitest'

import { resolveSelectedProjectId } from '../src/popup/project-selection'
import type { AgentProject } from '../src/papertrail/types'

const projects: AgentProject[] = [
  { id: 'project-1', name: 'Project One' },
  { id: 'project-2', name: 'Project Two' },
]

describe('resolveSelectedProjectId', () => {
  it('picks the remembered project when it is still accessible', () => {
    expect(resolveSelectedProjectId(projects, 'project-2')).toBe('project-2')
  })

  it('falls back to the first project when nothing was remembered', () => {
    expect(resolveSelectedProjectId(projects, null)).toBe('project-1')
  })

  it('falls back to the first project when the remembered one is no longer accessible', () => {
    expect(resolveSelectedProjectId(projects, 'project-9')).toBe('project-1')
  })

  it('returns null when there are no accessible projects at all', () => {
    expect(resolveSelectedProjectId([], 'project-1')).toBeNull()
  })
})
