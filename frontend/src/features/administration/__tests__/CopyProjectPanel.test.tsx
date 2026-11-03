import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CopyProjectPanel } from '../CopyProjectPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function clickCopy() {
  const button = screen.getAllByRole('button', { name: 'Copy Project' })
    .find((candidate) => !candidate.hasAttribute('aria-expanded'))!
  fireEvent.click(button)
}

const queuedJob = {
  id: 'job-1',
  jobType: 'clone_project',
  status: 'queued',
  progressCurrent: 0,
  progressTotal: 0,
  progressMessage: null,
  errorMessage: null,
  createdAt: '2026-11-03T10:00:00Z',
  completedAt: null,
  result: null,
}

describe('CopyProjectPanel', () => {
  it('queues a copy under the chosen name and links to it once the job finishes', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url === '/api/v1/projects/p1/clone' && init?.method === 'POST') {
        return jsonResponse(queuedJob, 202)
      }
      if (url === '/api/v1/projects/p1/jobs') {
        return jsonResponse([
          {
            ...queuedJob,
            status: 'completed',
            completedAt: '2026-11-03T10:01:00Z',
            result: { projectId: 'p2', projectName: 'Pilot copy', missingFiles: 0 },
          },
        ])
      }
      if (url === '/api/v1/projects/p1') return jsonResponse({ name: 'Urban VR Review' })
      return jsonResponse({})
    })
    renderWithProviders(<CopyProjectPanel projectId="p1" />)

    const input = await screen.findByDisplayValue('Copy of Urban VR Review')
    fireEvent.change(input, { target: { value: 'Pilot copy' } })
    clickCopy()

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: 'Pilot copy' })
    })
    const link = await screen.findByRole('link', { name: 'Pilot copy' })
    expect(link).toHaveAttribute('href', '/projects/p2')
  })

  it('explains a refusal while background jobs are still running', async () => {
    mockFetch((input, init) => {
      if (init?.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'project_jobs_running',
              message: 'Wait for running background jobs to finish before copying the project',
              details: { operation: 'clone', runningJobCount: 1, runningJobTypes: ['detect_duplicates'] },
            },
          },
          409,
        )
      }
      if (String(input) === '/api/v1/projects/p1') return jsonResponse({ name: 'Urban VR Review' })
      return jsonResponse({})
    })
    renderWithProviders(<CopyProjectPanel projectId="p1" />)

    await screen.findByDisplayValue('Copy of Urban VR Review')
    clickCopy()

    expect(
      await screen.findByText(/1 background job is still running.*before copying the project/),
    ).toHaveAttribute('role', 'alert')
  })
})
