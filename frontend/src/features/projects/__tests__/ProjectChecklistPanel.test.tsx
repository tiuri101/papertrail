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
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

    expect(await screen.findByText("What's Next: Set Up the Project")).toBeInTheDocument()

    const rqCheckbox = screen.getByRole('checkbox', { name: /Add at least one research question/ })
    expect(rqCheckbox).toBeChecked()
    expect(rqCheckbox).toBeDisabled()
    expect(rqCheckbox.closest('li')).toHaveAttribute('data-state', 'complete')
    const criteriaCheckbox = screen.getByRole('checkbox', { name: /Add inclusion and exclusion criteria/ })
    expect(criteriaCheckbox).not.toBeChecked()
    expect(criteriaCheckbox.closest('li')).toHaveAttribute('data-state', 'open')
    expect(screen.getAllByText('Completed')).toHaveLength(1)
    expect(screen.getAllByText('Open')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Edit inclusion/exclusion criteria' }))
      .toHaveAttribute('href', '/projects/p1/research-agenda')
    expect(screen.getByRole('link', { name: 'Import publications' }))
      .toHaveAttribute('href', '/projects/p1/imports')
    expect(screen.queryByRole('link', { name: 'Add research questions' })).not.toBeInTheDocument()

    expect(screen.queryByText('Resolve Duplicates')).not.toBeInTheDocument()
    expect(screen.queryByText(/Detect duplicate publications/)).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Move Project to Duplicate Review' })).toBeDisabled()
  })

  it('hides the ready action from regular users, even once every item is complete', async () => {
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
    mockFetch(() => jsonResponse(completeChecklist))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage={false} />)

    await screen.findByText("What's Next: Set Up the Project")
    expect(screen.queryByRole('button', { name: 'Move Project to Duplicate Review' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Waiting for the project owner to move this project to Duplicate Review.',
    )
  })

  it('does not show the owner waiting message while a regular reviewer still has open setup tasks', async () => {
    mockFetch(() => jsonResponse(draftChecklist))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage={false} />)

    await screen.findByText("What's Next: Set Up the Project")
    expect(screen.queryByText(/Waiting for the project owner/)).not.toBeInTheDocument()
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
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

    expect(await screen.findByText("What's Next: Resolve Duplicates")).toBeInTheDocument()
    expect(screen.getByText(/automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('Set Up the Project')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open duplicate detection' }))
      .toHaveAttribute('href', '/projects/p1/duplicates')
    expect(screen.getByRole('link', { name: 'Review duplicate candidates' }))
      .toHaveAttribute('href', '/projects/p1/duplicates')
  })

  it('links unresolved full-text retrievals to the retrieval forms', async () => {
    mockFetch(() => jsonResponse({
      stage: 'full_text_screening',
      stages: [{
        stage: 'full_text_screening',
        label: 'Retrieve and Screen Full Texts',
        isCurrent: true,
        isComplete: false,
        autoAdvances: true,
        action: null,
        items: [{
          key: 'full_text_retrieval',
          label: 'Resolve full-text retrievals',
          done: false,
          detail: '2 publications missing PDFs',
        }],
      }],
    }))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

    expect(await screen.findByRole('link', { name: 'Resolve full-text retrievals' }))
      .toHaveAttribute('href', '/projects/p1/full-text')
  })

  it('offers results and export actions when the review is complete', async () => {
    mockFetch(() => jsonResponse({
      stage: 'completed',
      stages: [{
        stage: 'completed',
        label: 'Completed',
        isCurrent: true,
        isComplete: true,
        autoAdvances: false,
        action: null,
        items: [],
      }],
    }))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

    expect(await screen.findByRole('heading', { name: 'Your review is complete' })).toBeInTheDocument()
    expect(screen.queryByText('Nothing left to do here.')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View Final Results' }))
      .toHaveAttribute('href', '/projects/p1/results')
    expect(screen.getByRole('link', { name: 'Explore Charts & Analysis' }))
      .toHaveAttribute('href', '/projects/p1/analysis')
    expect(screen.getByRole('link', { name: 'Open Reporting and Exports' }))
      .toHaveAttribute('href', '/projects/p1/reporting')
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
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

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
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

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
    const { queryClient } = renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

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
    const { queryClient } = renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await screen.findByText("What's Next: Set Up the Project")

    stage = 'duplicate_review'
    await queryClient.invalidateQueries({ queryKey: ['project-checklist', 'p1'] })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['project', 'p1'] })
    })
  })

  it('renders the LLM validation checkbox when the backend enables it for extraction', async () => {
    mockFetch(() => jsonResponse({
      stage: 'extraction_quality',
      stages: [{
        stage: 'extraction_quality',
        label: 'Data Extraction and Quality Assessment',
        isCurrent: true,
        isComplete: false,
        autoAdvances: true,
        action: null,
        items: [
          {
            key: 'extraction',
            label: 'Complete data extraction for every included publication',
            done: true,
            detail: '3 of 3 extracted',
          },
          {
            key: 'llm_extraction_validation',
            label: 'Complete LLM validation of the human extractions',
            done: false,
            detail: '1 of 3 validated, 2 processing',
          },
        ],
      }],
    }))
    renderWithProviders(<ProjectChecklistPanel projectId="p1" canManage />)

    const validation = await screen.findByRole('checkbox', {
      name: /Complete LLM validation of the human extractions/,
    })
    expect(validation).not.toBeChecked()
    expect(screen.getByText(/1 of 3 validated, 2 processing/)).toBeInTheDocument()
  })
})
