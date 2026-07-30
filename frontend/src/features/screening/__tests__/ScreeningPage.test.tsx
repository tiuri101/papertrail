import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScreeningPage } from '../ScreeningPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const workItem = {
  id: 'work-1',
  publication: {
    title: 'Immersive Urban Analytics',
    authors: 'A. Author; B. Reviewer',
    abstract: 'A study of urban data in virtual reality.',
    doi: '10.1000/example',
    publisherUrl: 'https://publisher.example/paper',
  },
  criteria: [
    { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
    { id: 'criterion-2', kind: 'exclusion', text: 'Is an editorial' },
  ],
  draft: {},
}

function renderScreening(handler: Parameters<typeof mockFetch>[0], stage = 'title_abstract') {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<ScreeningPage />, {
    route: `/projects/project-1/screening/${stage}`,
    path: '/projects/:projectId/screening/:stage',
  })
  return fetchMock
}

function projectResponse(stage = 'title_abstract') {
  return jsonResponse({
    exclusionReasons: [
      { id: 'reason-wrong-topic', stage, label: 'Wrong topic' },
      { id: 'reason-other-stage', stage: stage === 'title_abstract' ? 'full_text' : 'title_abstract', label: 'Other stage' },
    ],
  })
}

describe('ScreeningPage', () => {
  it('requires an explicit answer for every criterion before submission', async () => {
    renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return projectResponse()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Get next publication' }))
    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()

    const submit = screen.getByRole('button', { name: 'Submit decision' })
    expect(submit).toBeDisabled()
    expect(screen.getByText('Answer every criterion before submitting.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('inclusion: Uses virtual reality'), { target: { value: 'true' } })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('exclusion: Is an editorial'), { target: { value: 'false' } })
    expect(submit).toBeEnabled()
  })

  it('requires a stage-specific exclusion reason and submits the completed decision', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return projectResponse()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Get next publication' }))
    await screen.findByText('A study of urban data in virtual reality.')
    fireEvent.change(screen.getByLabelText('inclusion: Uses virtual reality'), { target: { value: 'true' } })
    fireEvent.change(screen.getByLabelText('exclusion: Is an editorial'), { target: { value: 'false' } })
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })

    expect(screen.getByRole('button', { name: 'Submit decision' })).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Wrong topic' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Other stage' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Exclusion reason'), { target: { value: 'reason-wrong-topic' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Outside the review scope.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Get next publication' })).toBeInTheDocument())
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/decision'))
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      exclusionReasonId: 'reason-wrong-topic',
      notes: 'Outside the review scope.',
    })
  })

  it('restores saved criterion answers from the work-item draft', async () => {
    renderScreening(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ ...workItem, draft: { criteriaAnswers: { 'criterion-1': true } } })
      : projectResponse())

    fireEvent.click(screen.getByRole('button', { name: 'Get next publication' }))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByLabelText('inclusion: Uses virtual reality')).toHaveValue('true')
    expect(screen.getByLabelText('exclusion: Is an editorial')).toHaveValue('')
  })

  it('reports that the queue has no available work', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : projectResponse())
    fireEvent.click(screen.getByRole('button', { name: 'Get next publication' }))
    expect(await screen.findByText('No publications are currently available.')).toBeInTheDocument()
  })

  it('uses the full-text heading and full-text exclusion reasons', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : projectResponse('full_text'), 'full_text')
    expect(screen.getByRole('heading', { name: 'Full-text screening' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Get next publication' }))
    await screen.findByText(workItem.publication.abstract)
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })
    expect(screen.getByRole('option', { name: 'Wrong topic' })).toBeInTheDocument()
  })
})
