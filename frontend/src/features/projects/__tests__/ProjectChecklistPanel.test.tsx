import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProjectChecklistPanel } from '../ProjectChecklistPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const draftChecklist = {
  stage: 'draft',
  stages: [
    {
      stage: 'draft',
      label: 'Set Up the Project',
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
      label: 'Resolve Duplicates',
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

    expect(await screen.findByText("What's Next: Set Up the Project")).toBeInTheDocument()

    const rqCheckbox = screen.getByRole('checkbox', { name: /Add at least one research question/ })
    expect(rqCheckbox).toBeChecked()
    expect(rqCheckbox).toBeDisabled()
    const criteriaCheckbox = screen.getByRole('checkbox', { name: /Add inclusion and exclusion criteria/ })
    expect(criteriaCheckbox).not.toBeChecked()

    expect(screen.queryByText('Resolve Duplicates')).not.toBeInTheDocument()
    expect(screen.queryByText(/Detect duplicate publications/)).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Move Project to Duplicate Review' })).toBeDisabled()
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

    expect(await screen.findByText("What's Next: Resolve Duplicates")).toBeInTheDocument()
    expect(screen.getByText(/automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Set Up the Project')).not.toBeInTheDocument()
  })

  it('marks the project ready and refreshes the checklist', async () => {
    const completeChecklist = {
      ...draftChecklist,
      stages: [
        {
          ...draftChecklist.stages[0],
          items: draftChecklist.stages[0].items.map((item) => ({ ...item, done: true })),
        },
        draftChecklist.stages[1],
      ],
    }
    const fetchMock = mockFetch((input, init) => {
      if (String(input).endsWith('/ready') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', stage: 'duplicate_review' }, 202)
      }
      return jsonResponse(completeChecklist)
    })
    renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    const button = await screen.findByRole('button', { name: 'Move Project to Duplicate Review' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/ready') && init?.method === 'POST')
      expect(call).toBeTruthy()
    })
  })

  it('disables the ready action until every checklist item is complete', async () => {
    mockFetch(() => jsonResponse(draftChecklist))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    expect(await screen.findByRole('button', { name: 'Move Project to Duplicate Review' })).toBeDisabled()
  })

  it('enables the ready action once outstanding work finishes, as background polling would deliver', async () => {
    let itemsDone = false
    mockFetch(() => jsonResponse({
      ...draftChecklist,
      stages: [
        {
          ...draftChecklist.stages[0],
          items: draftChecklist.stages[0].items.map((item) => ({ ...item, done: itemsDone || item.key === 'research_questions' })),
        },
        draftChecklist.stages[1],
      ],
    }))
    const { queryClient } = renderWithProviders(<ProjectChecklistPanel projectId="p1" />)

    expect(await screen.findByRole('button', { name: 'Move Project to Duplicate Review' })).toBeDisabled()

    itemsDone = true
    await queryClient.invalidateQueries({ queryKey: ['project-checklist', 'p1'] })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Move Project to Duplicate Review' })).not.toBeDisabled()
    })
  })

  it('invalidates the project query once the checklist reports a stage change', async () => {
    let stage = 'draft'
    mockFetch(() => jsonResponse({ ...draftChecklist, stage }))
    const { queryClient } = renderWithProviders(<ProjectChecklistPanel projectId="p1" />)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await screen.findByText("What's Next: Set Up the Project")

    stage = 'duplicate_review'
    await queryClient.invalidateQueries({ queryKey: ['project-checklist', 'p1'] })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'p1'] })
    })
  })
})
