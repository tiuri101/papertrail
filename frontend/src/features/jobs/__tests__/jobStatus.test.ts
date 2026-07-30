import { describe, expect, it } from 'vitest'

import { findJob, hasActiveJob, isJobActive } from '../jobStatus'

describe('isJobActive', () => {
  it('treats queued and running as active, and everything else as terminal', () => {
    expect(isJobActive('queued')).toBe(true)
    expect(isJobActive('running')).toBe(true)
    expect(isJobActive('completed')).toBe(false)
    expect(isJobActive('failed')).toBe(false)
    expect(isJobActive('cancelled')).toBe(false)
  })
})

describe('hasActiveJob', () => {
  it('is true when any job in the list is queued or running', () => {
    expect(hasActiveJob([{ status: 'completed' }, { status: 'running' }])).toBe(true)
  })

  it('is false once every job has reached a terminal status', () => {
    expect(hasActiveJob([{ status: 'completed' }, { status: 'failed' }])).toBe(false)
  })

  it('is false for missing or malformed data instead of throwing', () => {
    expect(hasActiveJob(undefined)).toBe(false)
    expect(hasActiveJob({ jobId: 'not-a-list' })).toBe(false)
  })
})

describe('findJob', () => {
  const jobs = [
    { id: 'a', status: 'queued' },
    { id: 'b', status: 'completed' },
  ]

  it('locates a job by id', () => {
    expect(findJob(jobs, 'b')?.status).toBe('completed')
  })

  it('returns undefined for an unknown id or malformed data', () => {
    expect(findJob(jobs, 'missing')).toBeUndefined()
    expect(findJob(undefined, 'a')).toBeUndefined()
    expect(findJob({ jobId: 'not-a-list' }, 'a')).toBeUndefined()
  })
})
