import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectPage } from '../ProjectPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectPage', () => {
  it('renders project context, status, checklist, and a stage-aware workflow nav', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) {
        return jsonResponse({
          stage: 'title_abstract_screening',
          stages: [
            {
              stage: 'title_abstract_screening',
              label: 'Title/Abstract Screening',
              isCurrent: true,
              isComplete: false,
              autoAdvances: true,
              action: null,
              items: [{ key: 'title_abstract_decisions', label: 'Reach a final decision for every publication', done: false, detail: '0 of 10 decided' }],
            },
          ],
        })
      }
      if (url.endsWith('/dashboard')) {
        return jsonResponse({ stage: 'title_abstract_screening', unresolvedDuplicates: 0 })
      }
      if (url.endsWith('/integrity')) return jsonResponse({ issues: [] })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([{ id: 'conflict-1' }])
      return jsonResponse({
        id: 'p1',
        name: 'Immersive analytics review',
        stage: 'title_abstract_screening',
        canManage: true,
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: true,
        canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    expect(await screen.findByRole('heading', { name: 'Immersive analytics review' })).toBeInTheDocument()
    expect(document.title).toBe('Immersive analytics review · Papertrail')
    expect(screen.getByRole('link', { name: 'Title/Abstract Screening' })).toHaveAttribute('href', '/projects/p1/screening/title_abstract')
    expect(screen.queryByRole('heading', { name: 'Reporting' })).not.toBeInTheDocument()
    const completedGroup = screen.getByRole('heading', { name: 'Completed' }).closest('.nav-group') as HTMLElement
    expect(within(completedGroup).getByRole('link', { name: 'Charts & Analysis' }))
      .toHaveAttribute('href', '/projects/p1/analysis')
    expect(within(completedGroup).getByText('Final Results')).toHaveAttribute('aria-disabled', 'true')
    expect(within(completedGroup).getByText('Reporting and Exports')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/Actions unlock review stage by review stage/)).toBeInTheDocument()

    const currentStage = screen.getByRole('listitem', { current: 'step' })
    expect(currentStage).toHaveTextContent('Title/Abstract Screening')
    const draftStage = screen.getAllByRole('listitem').find((item) => item.textContent === 'Draft')
    expect(draftStage).not.toHaveAttribute('aria-current')

    expect(await screen.findByText("What's Next: Title/Abstract Screening")).toBeInTheDocument()
    expect(screen.getByText(/Reach a final decision for every publication/)).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: 'Project Status' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 open metadata conflict found')
    expect(screen.getByRole('link', { name: 'Review metadata conflicts' })).toHaveAttribute('href', '/projects/p1/publications?tab=metadata#metadata-conflicts')
    expect(screen.getByRole('rowheader', { name: 'Unresolved duplicates' })).toBeInTheDocument()

    const currentGroupHeading = screen
      .getAllByText('Title/Abstract Screening')
      .find((el) => el.tagName === 'H3')
    const currentGroup = currentGroupHeading?.closest('.nav-group')
    expect(currentGroup).not.toHaveClass('nav-group--upcoming')
    const pastGroup = screen.getByRole('heading', { name: 'Duplicate Review' }).closest('.nav-group')
    expect(pastGroup).not.toHaveClass('nav-group--upcoming')
    const upcomingGroupHeading = screen.getAllByText('Extraction & Quality').find((el) => el.tagName === 'H3')
    const upcomingGroup = upcomingGroupHeading?.closest('.nav-group')
    expect(upcomingGroup).toHaveClass('nav-group--upcoming')
    const workflow = screen.getByRole('navigation', { name: 'Project workflow' })
    const actionStages = within(workflow).getAllByRole('listitem')
    expect(actionStages).toHaveLength(7)
    expect(actionStages.map((stage) => within(stage).getByRole('heading').textContent)).toEqual([
      'Administration',
      'Draft',
      'Duplicate Review',
      'Title/Abstract Screening',
      'Full-Text Screening',
      'Extraction & Quality',
      'Completed',
    ])
    expect(actionStages[0]).toHaveTextContent('Project Administration')
    expect(actionStages[0]).toHaveTextContent('Setup Wizard')
    expect(actionStages[0]).toHaveTextContent('Publications')
    expect(actionStages[0]).toHaveTextContent('Jobs')
    expect(actionStages[0]).not.toHaveTextContent('Searches and Imports')
    expect(actionStages[0]).not.toHaveClass('nav-group--upcoming')
    expect(within(actionStages[0]).getByText('0')).toHaveClass('workflow-nav__number')
    expect(actionStages[1]).toHaveTextContent('Draft')
    expect(actionStages[1]).toHaveTextContent('Searches and Imports')
    expect(actionStages[1]).not.toHaveTextContent('Publications')
    expect(actionStages[1]).not.toHaveTextContent('Project Administration')
    expect(within(actionStages[1]).getByText('1')).toHaveClass('workflow-nav__number')
    expect(screen.queryByText('Add a Publication')).not.toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Actions' }).closest('.card')).toContainElement(
      workflow,
    )
    expect(screen.queryByRole('link', { name: 'Data Extraction' })).not.toBeInTheDocument()
    const disabledExtraction = screen.getByText('Data Extraction')
    expect(disabledExtraction.tagName).toBe('SPAN')
    expect(disabledExtraction).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows workflow integrity errors on the project main page', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/integrity')) {
        return jsonResponse({
          issues: [
            {
              code: 'missing_extraction_item',
              entityId: 'publication-1',
              message: 'Included publication has no extraction work item.',
            },
          ],
        })
      }
      if (url.endsWith('/checklist')) {
        return jsonResponse({ stage: 'extraction_quality', stages: [] })
      }
      if (url.endsWith('/dashboard')) {
        return jsonResponse({ stage: 'extraction_quality' })
      }
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1',
        name: 'Review',
        stage: 'extraction_quality',
        canManage: true,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: true,
        canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Workflow integrity issue')
    expect(alert).toHaveTextContent('Included publication has no extraction work item.')
  })

  it('lets the project owner repair a workflow integrity issue', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/integrity/repair') && init?.method === 'POST') {
        return jsonResponse({
          removedFullTextWorkItems: 0,
          removedFullTextRetrievals: 1,
          advancedToExtraction: false,
          createdExtractionItems: 1,
          createdQualityItems: 0,
        })
      }
      if (url.endsWith('/integrity')) {
        return jsonResponse({
          issues: [
            {
              code: 'missing_extraction_item',
              entityId: 'publication-1',
              message: 'Included publication has no extraction work item.',
            },
          ],
        })
      }
      if (url.endsWith('/checklist')) {
        return jsonResponse({ stage: 'extraction_quality', stages: [] })
      }
      if (url.endsWith('/dashboard')) {
        return jsonResponse({ stage: 'extraction_quality' })
      }
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1',
        name: 'Review',
        stage: 'extraction_quality',
        canManage: true,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: true,
        canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    fireEvent.click(await screen.findByRole('button', { name: 'Repair Workflow Integrity' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('This cannot be undone.')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Repair' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/integrity/repair')
    })
    expect(await screen.findByText(/Repaired:/)).toHaveTextContent(
      'Repaired: cleared stray full-text screening work left over from a reversed decision; created 1 extraction work item.',
    )
  })

  it('does not show a repair action for a reviewer without manage access', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) return jsonResponse({ stage: 'extraction_quality', stages: [] })
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'extraction_quality' })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1',
        name: 'Review',
        stage: 'extraction_quality',
        canManage: false,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: true,
        canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    await screen.findByRole('heading', { name: 'Review' })
    expect(screen.queryByRole('button', { name: 'Repair Workflow Integrity' })).not.toBeInTheDocument()
  })

  it('renders no workflow-integrity status when the project is valid', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/integrity')) return jsonResponse({ issues: [] })
      if (url.endsWith('/checklist')) return jsonResponse({ stage: 'draft', stages: [] })
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'draft' })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1',
        name: 'Valid Review',
        stage: 'draft',
        canManage: true,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: true,
        canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    await screen.findByRole('heading', { name: 'Valid Review' })
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/integrity')),
      ).toBe(true)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/consistency issues detected/i)).not.toBeInTheDocument()
  })

  it('shows a per-stage background job completion summary in the Actions section', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) return jsonResponse({ stage: 'extraction_quality', stages: [] })
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'extraction_quality' })
      if (url.endsWith('/integrity')) return jsonResponse({ issues: [] })
      if (url.endsWith('/jobs/summary')) {
        return jsonResponse([
          { stage: 'Duplicate review', completed: 1, total: 1, active: false },
          { stage: 'Data extraction', completed: 2, total: 3, active: true },
        ])
      }
      return jsonResponse({
        id: 'p1', name: 'Review', stage: 'extraction_quality', canManage: true,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true, canFullTextScreen: true,
        canExtract: true, canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    const dedupHeading = await screen.findByRole('heading', { name: /Duplicate Review/ })
    expect(dedupHeading).toHaveTextContent('All background jobs completed')
    const extractionHeading = screen.getByRole('heading', { name: /Extraction & Quality/ })
    expect(extractionHeading).toHaveTextContent('2/3 background jobs completed')
    const screeningHeading = screen.getByRole('heading', { name: /Title\/Abstract Screening/ })
    expect(screeningHeading).not.toHaveTextContent('background jobs')
  })

  it('shows duplicate detection rerun under Duplicate Review for the project owner', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) {
        return jsonResponse({
          stage: 'duplicate_review',
          stages: [{
            stage: 'duplicate_review', label: 'Resolve Duplicates', isCurrent: true,
            isComplete: false, autoAdvances: true, action: null, items: [],
          }],
        })
      }
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'duplicate_review' })
      if (url.endsWith('/integrity')) return jsonResponse({ issues: [] })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse({
        id: 'p1', name: 'Review', stage: 'duplicate_review', canManage: true,
        extractionValidationEnabled: false,
        canTitleAbstractScreen: true, canFullTextScreen: true,
        canExtract: true, canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    const group = (await screen.findByRole('heading', { name: 'Duplicate Review' })).closest('.nav-group') as HTMLElement
    expect(within(group).getByRole('button', { name: 'Re-run Duplicate Detection' })).toBeInTheDocument()
  })

  it('shows the validation review action only when extraction validation is enabled', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) {
        return jsonResponse({
          stage: 'extraction_quality',
          stages: [{
            stage: 'extraction_quality', label: 'Data Extraction and Quality Assessment',
            isCurrent: true, isComplete: false, autoAdvances: true, action: null, items: [],
          }],
        })
      }
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'extraction_quality' })
      if (url.endsWith('/integrity')) return jsonResponse({ issues: [] })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1', name: 'Review', stage: 'extraction_quality', canManage: true,
        extractionValidationEnabled: true,
        canTitleAbstractScreen: true, canFullTextScreen: true,
        canExtract: true, canAssessQuality: true,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    expect(await screen.findByRole('link', { name: 'Review LLM Extraction Validation' })).toHaveAttribute(
      'href',
      '/projects/p1/extraction/validation',
    )
  })

  it('hides screening, extraction, and quality actions a reviewer is not assigned to', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) return jsonResponse({ stage: 'extraction_quality', stages: [] })
      if (url.endsWith('/dashboard')) return jsonResponse({ stage: 'extraction_quality' })
      if (url.endsWith('/jobs/summary')) return jsonResponse([])
      return jsonResponse({
        id: 'p1',
        name: 'Review',
        stage: 'extraction_quality',
        canManage: false,
        extractionValidationEnabled: true,
        canTitleAbstractScreen: false,
        canFullTextScreen: false,
        canExtract: true,
        canAssessQuality: false,
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    expect(await screen.findByRole('link', { name: 'Data Extraction' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'My Submitted Extractions' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review LLM Extraction Validation' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Quality Assessment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'My Submitted Quality Assessments' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Title\/Abstract Screening/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Full-Text Screening/ })).not.toBeInTheDocument()
  })
})
