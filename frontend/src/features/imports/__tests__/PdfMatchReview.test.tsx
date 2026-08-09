import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PdfMatchReview } from '../PdfMatchReview'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const review = {
  summary: { total: 3, matched: 0, ambiguous: 1, unmatched: 1, duplicate: 0, conflict_existing_pdf: 1, invalid: 0, skipped: 0 },
  publications: [
    { id: 'pub-1', title: 'Urban systems', authors: 'Doe', publicationYear: 2026, hasPdf: false },
    { id: 'pub-2', title: 'Existing paper', authors: 'Smith', publicationYear: 2025, hasPdf: true },
  ],
  items: [
    { id: 'item-1', originalFilename: 'urban.pdf', fileSize: 10, detectedDoi: null, detectedTitle: 'Urban systems', detectedAuthors: 'Doe', detectedYear: 2026, status: 'ambiguous', candidates: [{ publicationId: 'pub-1', title: 'Urban systems', reason: 'exact_metadata_title' }], matchedPublicationId: null, errorMessage: null },
    { id: 'item-2', originalFilename: 'unknown.pdf', fileSize: 10, detectedDoi: null, detectedTitle: null, detectedAuthors: null, detectedYear: null, status: 'unmatched', candidates: [], matchedPublicationId: null, errorMessage: null },
    { id: 'item-3', originalFilename: 'replacement.pdf', fileSize: 10, detectedDoi: null, detectedTitle: 'Existing paper', detectedAuthors: null, detectedYear: null, status: 'conflict_existing_pdf', candidates: [], matchedPublicationId: 'pub-2', errorMessage: null },
  ],
}

describe('PdfMatchReview', () => {
  it('resolves ambiguous and unmatched PDFs with a selected publication', async () => {
    const fetchMock = mockFetch((_input, init) => (
      init?.method === 'POST' ? jsonResponse({ status: 'matched' }) : jsonResponse(review)
    ))
    renderWithProviders(<PdfMatchReview projectId="p1" importBatchId="batch-1" />)

    expect(await screen.findByText('urban.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Attach' })[0])
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        itemId: 'item-1', publicationId: 'pub-1', action: 'attach',
      })
    })

    fireEvent.change(screen.getByLabelText('Publication match for unknown.pdf'), {
      target: { value: 'pub-1' },
    })
    expect(screen.getAllByRole('button', { name: 'Attach' })[1]).not.toBeDisabled()
  })

  it('defaults existing-PDF conflicts to keeping the existing PDF', async () => {
    const fetchMock = mockFetch((_input, init) => (
      init?.method === 'POST' ? jsonResponse({ status: 'skipped' }) : jsonResponse(review)
    ))
    renderWithProviders(<PdfMatchReview projectId="p1" importBatchId="batch-1" />)
    await screen.findByText('replacement.pdf')
    fireEvent.click(screen.getByRole('button', { name: 'Keep existing' }))
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(JSON.parse(String(post?.[1]?.body)).action).toBe('keep_existing')
    })
  })
})
