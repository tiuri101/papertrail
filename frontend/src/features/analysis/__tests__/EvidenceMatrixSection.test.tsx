import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { EvidenceMatrixSection } from '../EvidenceMatrixSection'
import type { EvidenceCellDetail, EvidenceMatrixResponse } from '../useEvidenceMatrix'

function matrixResponse(page = 1): EvidenceMatrixResponse {
  return {
    columns: [
      {
        key: 'extraction:design',
        label: 'Study Design',
        fieldType: 'single_select',
        source: 'extraction',
        options: ['RCT', 'Cohort'],
      },
      {
        key: 'quality:score',
        label: 'Quality Score',
        fieldType: 'number',
        source: 'quality',
        options: null,
      },
    ],
    items: [
      {
        publication: { id: 'pub-1', title: 'Alpha Study', authors: 'Adams, A', publicationYear: 2021 },
        cells: {
          'extraction:design': { value: 'RCT', state: 'answered', hasEvidence: true },
          'quality:score': { value: null, state: 'missing', hasEvidence: false },
        },
      },
      {
        publication: { id: 'pub-2', title: 'Beta Study', authors: 'Brown, B', publicationYear: 2022 },
        cells: {
          'extraction:design': { value: null, state: 'pending_reconciliation', hasEvidence: false },
          'quality:score': { value: 7, state: 'answered', hasEvidence: false },
        },
      },
    ],
    total: 2,
    page,
    pageSize: 25,
    qualityEnabled: true,
  }
}

const cellDetailWithEvidence: EvidenceCellDetail = {
  publication: { id: 'pub-1', title: 'Alpha Study' },
  fieldKey: 'design',
  label: 'Study Design',
  fieldType: 'single_select',
  sourceType: 'extraction',
  value: 'RCT',
  state: 'answered',
  resolutionMethod: 'agreement',
  resolvedAt: '2026-07-01T00:00:00Z',
  evidence: [{ page: 3, quote: 'Patients were randomized to two arms.', section: 'Methods', verified: true }],
}

const cellDetailWithoutEvidence: EvidenceCellDetail = {
  publication: { id: 'pub-2', title: 'Beta Study' },
  fieldKey: 'score',
  label: 'Quality Score',
  fieldType: 'number',
  sourceType: 'quality',
  value: 7,
  state: 'answered',
  resolutionMethod: 'single_reviewer',
  resolvedAt: '2026-07-02T00:00:00Z',
  evidence: [],
}

function baseHandler(input: RequestInfo | URL, init?: RequestInit) {
  const path = String(input)
  if (path.endsWith('/evidence-matrix')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    return jsonResponse(matrixResponse(body.page ?? 1))
  }
  if (path.includes('/evidence-matrix/cell/pub-1/extraction/design')) {
    return jsonResponse(cellDetailWithEvidence)
  }
  if (path.includes('/evidence-matrix/cell/pub-2/quality/score')) {
    return jsonResponse(cellDetailWithoutEvidence)
  }
  return jsonResponse({})
}

describe('EvidenceMatrixSection', () => {
  it('renders answered, missing, and pending-reconciliation cells distinctly', async () => {
    mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Alpha Study')
    const alphaRow = screen.getByText('Alpha Study').closest('tr') as HTMLElement
    expect(within(alphaRow).getByRole('button', { name: /RCT/ })).toBeInTheDocument()
    expect(within(alphaRow).getByText('—')).toBeInTheDocument()

    const betaRow = screen.getByText('Beta Study').closest('tr') as HTMLElement
    expect(within(betaRow).getByRole('button', { name: 'Pending reconciliation' })).toBeInTheDocument()
    expect(within(betaRow).getByRole('button', { name: '7' })).toBeInTheDocument()
  })

  it('opens the cell detail panel with source evidence for a traceable value', async () => {
    mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Alpha Study')
    fireEvent.click(screen.getByRole('button', { name: /RCT/ }))

    const detail = await screen.findByRole('complementary', { name: 'Field evidence detail' })
    expect(await within(detail).findByText('Reviewer agreement')).toBeInTheDocument()
    expect(within(detail).getByText(/Patients were randomized/)).toBeInTheDocument()
  })

  it('shows a clear "no traceable source" state when a value has no evidence', async () => {
    mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Beta Study')
    const betaRow = screen.getByText('Beta Study').closest('tr') as HTMLElement
    fireEvent.click(within(betaRow).getByRole('button', { name: '7' }))

    const detail = await screen.findByRole('complementary', { name: 'Field evidence detail' })
    expect(await within(detail).findByText('No traceable source quotation for this value.')).toBeInTheDocument()
  })

  it('sends updated search text to the server', async () => {
    const fetchMock = mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Alpha Study')
    fireEvent.change(screen.getByPlaceholderText(/Filter by title/), { target: { value: 'Adams' } })

    await waitFor(() => {
      const lastCall = fetchMock.mock.calls
        .filter(([input]) => String(input).endsWith('/evidence-matrix'))
        .at(-1)
      expect(lastCall).toBeDefined()
      const body = JSON.parse(String(lastCall?.[1]?.body))
      expect(body.search).toBe('Adams')
    })
  })

  it('sends a presence filter when a column is filtered to missing-only', async () => {
    const fetchMock = mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Alpha Study')
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter Quality Score' }), {
      target: { value: 'missing' },
    })

    await waitFor(() => {
      const lastCall = fetchMock.mock.calls
        .filter(([input]) => String(input).endsWith('/evidence-matrix'))
        .at(-1)
      const body = JSON.parse(String(lastCall?.[1]?.body))
      expect(body.filters['quality:score']).toEqual({ type: 'presence', state: 'missing' })
    })
  })

  it('toggles column visibility', async () => {
    mockFetch(baseHandler)
    renderWithProviders(<EvidenceMatrixSection projectId="p1" />)

    await screen.findByText('Alpha Study')
    expect(screen.getByRole('columnheader', { name: /Quality Score/ })).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Show\/hide columns/))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Quality Score' }))

    expect(screen.queryByRole('columnheader', { name: /Quality Score/ })).not.toBeInTheDocument()
  })
})
