import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MoveProjectBackPanel } from '../MoveProjectBackPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('MoveProjectBackPanel', () => {
  it('only offers stages before the current stage when moving an in-progress project back', async () => {
    mockFetch(() => jsonResponse({ stage: 'full_text_screening' }))
    renderWithProviders(<MoveProjectBackPanel projectId="p1" />)

    const moveBackSection = (await screen.findByRole('heading', { name: 'Move Project Back' }))
      .closest('section')
    expect(moveBackSection).toHaveAttribute('id', 'section-move-project-back')
    expect(screen.getByRole('option', { name: 'Duplicate Review' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Title Abstract Screening' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Extraction Quality' })).not.toBeInTheDocument()
  })

  it('renders nothing for a draft or completed project', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ stage: 'completed' }))
    renderWithProviders(<MoveProjectBackPanel projectId="p1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Move Project Back' })).not.toBeInTheDocument()
  })

  it('says which running jobs blocked the move instead of a generic failure', async () => {
    mockFetch((_input, init) => {
      if (init?.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'project_jobs_running',
              message: 'Wait for running background jobs to finish before moving the project back',
              details: {
                operation: 'move_back',
                runningJobCount: 1,
                runningJobTypes: ['export.generate'],
              },
            },
          },
          409,
        )
      }
      return jsonResponse({ stage: 'full_text_screening' })
    })
    renderWithProviders(<MoveProjectBackPanel projectId="p1" />)

    await screen.findByRole('heading', { name: 'Move Project Back' })
    // The section header is itself a button; the action is the one that isn't.
    fireEvent.click(screen.getAllByRole('button', { name: 'Move Project Back' })
      .find((candidate) => !candidate.hasAttribute('aria-expanded'))!)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Move Back' }))

    const alert = await screen.findByText(/background job is still running/)
    expect(alert).toHaveTextContent('1 background job is still running')
    expect(alert).toHaveTextContent('export generate')
    expect(alert).toHaveTextContent('before moving the project back')
  })
})
