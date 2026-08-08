import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FullTextDocumentPanel } from '../FullTextDocumentPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const endpoint = '/api/v1/projects/p1/publications/pub1/full-text'
const active = {
  available: true,
  document: {
    id: 'document-1',
    originalFilename: 'paper.pdf',
    fileSize: 4812931,
    uploadedAt: '2026-08-08T10:00:00Z',
    uploadedBy: { id: 'user-1', displayName: 'Reviewer A' },
    isActive: true,
    removedAt: null,
  },
}

describe('FullTextDocumentPanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('uploads a missing PDF and immediately shows the view action', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (String(input) === endpoint && init?.method === 'POST') return jsonResponse(active, 201)
      return jsonResponse({ available: false, document: null })
    })
    renderWithProviders(<FullTextDocumentPanel projectId="p1" publicationId="pub1" />)

    expect(await screen.findByText('No PDF attached')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Document history' })).toHaveClass(
      'full-text-history-toggle',
    )
    const file = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Choose PDF'), { target: { files: [file] } })

    expect(await screen.findByRole('link', { name: 'View PDF' })).toHaveAttribute(
      'href', `${endpoint}/content`,
    )
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[1]?.body).toBeInstanceOf(FormData)
    expect((post?.[1]?.body as FormData).get('file')).toBe(file)
  })

  it('confirms replacement, removes the active PDF, and retains history access', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchMock = mockFetch((input, init) => {
      if (String(input).endsWith('/history')) return jsonResponse([active.document])
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (init?.method === 'POST') return jsonResponse(active, 201)
      return jsonResponse(active)
    })
    renderWithProviders(<FullTextDocumentPanel projectId="p1" publicationId="pub1" />)

    await screen.findByText(/paper.pdf/)
    fireEvent.click(screen.getByRole('button', { name: 'Replace PDF' }))
    fireEvent.change(screen.getByLabelText('Choose replacement PDF'), {
      target: { files: [new File(['new'], 'final.pdf', { type: 'application/pdf' })] },
    })
    await waitFor(() => expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Remove PDF' }))
    expect(await screen.findByText('No PDF attached')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Document history' }))
    expect(await screen.findByText(/Current: paper.pdf/)).toBeInTheDocument()
  })

  it('shows upload errors without hiding the missing state', async () => {
    mockFetch((_input, init) => (
      init?.method === 'POST'
        ? jsonResponse({ error: { message: 'File is not a valid PDF' } }, 415)
        : jsonResponse({ available: false, document: null })
    ))
    renderWithProviders(<FullTextDocumentPanel projectId="p1" publicationId="pub1" />)
    await screen.findByText('No PDF attached')
    fireEvent.change(screen.getByLabelText('Choose PDF'), {
      target: { files: [new File(['bad'], 'bad.pdf')] },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('File is not a valid PDF')
    expect(screen.getByText('No PDF attached')).toBeInTheDocument()
  })
})
