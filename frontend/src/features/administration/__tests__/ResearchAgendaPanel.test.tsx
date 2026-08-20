import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CriteriaPanel, ResearchAgendaPanel, ResearchQuestionsPanel } from '../ResearchAgendaPanel'
import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const projectDetail = {
  id: 'p1',
  researchQuestions: [{ id: 'rq-1', text: 'How is urban data visualized?' }],
  criteria: [{ id: 'crit-1', kind: 'inclusion', text: 'Uses virtual reality' }],
}

describe('ResearchAgendaPanel', () => {
  it('adds a research question through a new inline row in setup mode', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'rq-2', text: 'New question', position: 1 }, 201)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ResearchQuestionsPanel projectId="p1" inlineAdd />)

    expect(await screen.findByText('How is urban data visualized?')).toBeInTheDocument()
    expect(screen.queryByLabelText('New research question')).not.toBeInTheDocument()

    const questionRow = screen.getByText('How is urban data visualized?').closest('tr') as HTMLElement
    const addQuestionButton = screen.getByRole('button', { name: 'Add research question' })
    const questionRows = Array.from(questionRow.closest('tbody')!.children)
    expect(questionRows.indexOf(addQuestionButton.closest('tr')!)).toBeGreaterThan(questionRows.indexOf(questionRow))

    fireEvent.click(addQuestionButton)
    const input = screen.getByLabelText('New research question')
    const draftRow = input.closest('tr') as HTMLElement
    expect(within(draftRow).getByText('RQ2')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'New question' } })
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/research-questions')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'New question' })
    })
  })

  it('uses separate inline add controls for inclusion and exclusion criteria in setup mode', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ id: 'crit-2', kind: 'exclusion', text: 'Editorial only', position: 1 }, 201)
      }
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<CriteriaPanel projectId="p1" inlineAdd />)

    const inclusionRow = (await screen.findByText('Uses virtual reality')).closest('tr') as HTMLElement
    const inclusionAdd = screen.getByRole('button', { name: 'Add inclusion criterion' })
    const exclusionAdd = screen.getByRole('button', { name: 'Add exclusion criterion' })
    const criteriaRows = Array.from(inclusionRow.closest('tbody')!.children)
    expect(criteriaRows.indexOf(inclusionAdd.closest('tr')!)).toBeGreaterThan(criteriaRows.indexOf(inclusionRow))
    expect(criteriaRows.indexOf(exclusionAdd.closest('tr')!)).toBe(criteriaRows.length - 1)
    fireEvent.click(exclusionAdd)

    const input = screen.getByLabelText('New exclusion criterion')
    const draftRow = input.closest('tr') as HTMLElement
    expect(within(draftRow).getByText('EC1')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Editorial only' } })
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/criteria')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        kind: 'exclusion',
        text: 'Editorial only',
      })
    })
  })

  it('adds a new research question', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'rq-2', text: 'New question', position: 1 }, 201)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ResearchAgendaPanel projectId="p1" />)

    expect(await screen.findByText('How is urban data visualized?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add research question' }))
    fireEvent.change(screen.getByLabelText('New research question'), { target: { value: 'New question' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/research-questions')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'New question' })
    })
  })

  it('edits a research question in place', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'PATCH') return jsonResponse({ id: 'rq-1', text: 'Revised question', position: 0 })
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ResearchAgendaPanel projectId="p1" />)

    const row = (await screen.findByText('How is urban data visualized?')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    const input = within(row).getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Revised question' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/research-questions/rq-1')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ text: 'Revised question' })
    })
  })

  it('deletes a criterion after confirming the warning', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'DELETE') return emptyResponse(204)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ResearchAgendaPanel projectId="p1" />)

    const row = (await screen.findByText(/Uses virtual reality/)).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(within(row).getByRole('alert')).toHaveTextContent(/cannot be undone/)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    fireEvent.click(within(row).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/criteria/crit-1')
    })
  })
})
