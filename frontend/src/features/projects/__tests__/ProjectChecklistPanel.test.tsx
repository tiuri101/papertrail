import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectChecklistPanel } from '../ProjectChecklistPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const draftChecklist = {
  stage: 'draft',
  stages: [
    {
      stage: 'draft',
      label: 'Set up the project',
      isCurrent: true,
      isComplete: false,
      autoAdvances: false,
      action: 'ready',
      items: [
        { key: 'research_questions', label: 'Add at least one research question', done: true, detail: '1 added' },
        { key: 'criteria', label: 'Add inclusion and exclusion criteria', done: false, detail: '0 inclusion, 0 exclusion' },
        { key: 'publications', label: 'Import publications to review', done: false, detail: '0 imported' },
      ],
    },
    {
      stage: 'duplicate_review',
      label: 'Resolve duplicates',
      isCurrent: false,
      isComplete: false,
      autoAdvances: true,
      action: null,
      items: [
        { key: 'detection', label: 'Detect duplicate publications', done: false, detail: 'Running…' },
        { key: 'resolve_duplicates', label: 'Resolve every duplicate candidate', done: false, detail: '0 of 0 resolved' },
      ],
    },
  ],
}

describe('ProjectChecklistPanel', () => {
  it('only shows checklist items for the current stage', async () => {
    mockFetch(() => jsonResponse(draftChecklist))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    expect(await screen.findByText("What's next: Set up the project")).toBeInTheDocument()

    const rqCheckbox = screen.getByRole('checkbox', { name: /Add at least one research question/ })
    expect(rqCheckbox).toBeChecked()
    expect(rqCheckbox).toBeDisabled()
    const criteriaCheckbox = screen.getByRole('checkbox', { name: /Add inclusion and exclusion criteria/ })
    expect(criteriaCheckbox).not.toBeChecked()

    expect(screen.queryByText('Resolve duplicates')).not.toBeInTheDocument()
    expect(screen.queryByText(/Detect duplicate publications/)).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Mark project ready' })).toBeInTheDocument()
  })

  it('explains that an auto-advancing stage needs no manual action', async () => {
    const checklist = {
      stage: 'duplicate_review',
      stages: [
        { ...draftChecklist.stages[0], isCurrent: false, isComplete: true },
        { ...draftChecklist.stages[1], isCurrent: true },
      ],
    }
    mockFetch(() => jsonResponse(checklist))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    expect(await screen.findByText("What's next: Resolve duplicates")).toBeInTheDocument()
    expect(screen.getByText(/automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Set up the project')).not.toBeInTheDocument()
  })

  it('marks the project ready and refreshes the checklist', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (String(input).endsWith('/ready') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', stage: 'duplicate_review' }, 202)
      }
      return jsonResponse(draftChecklist)
    })
    renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Mark project ready' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/ready') && init?.method === 'POST')
      expect(call).toBeTruthy()
    })
  })
})
