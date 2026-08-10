import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AddPublicationPage } from '../AddPublicationPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('AddPublicationPage', () => {
  it('is disabled until a title is entered, then submits and resets the form', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/publications') && init?.method === 'POST') {
        return jsonResponse({ id: 'publication-1', title: 'A Manually Added Paper' }, 201)
      }
      return jsonResponse({})
    })
    renderWithProviders(<AddPublicationPage />, { route: '/projects/p1/publications/add', path: '/projects/:projectId/publications/add' })

    const addButton = screen.getByRole('button', { name: 'Add Publication' })
    expect(addButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Manually Added Paper' } })
    expect(addButton).not.toBeDisabled()
    fireEvent.click(addButton)

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/publications') && init?.method === 'POST')
      expect(postCall).toBeTruthy()
      expect(postCall?.[0]).toBe('/api/v1/projects/p1/publications')
      expect(JSON.parse(String(postCall?.[1]?.body)).title).toBe('A Manually Added Paper')
    })
    expect(await screen.findByText('Publication added.')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('')
  })

  it('shows the server-provided error on failure', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Title is required' } }, 422))
    renderWithProviders(<AddPublicationPage />, { route: '/projects/p1/publications/add', path: '/projects/:projectId/publications/add' })

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Manually Added Paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Publication' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Title is required')
  })

  it('prefills the form from pasted BibTeX', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/imports/preview')) {
        return jsonResponse({
          filename: 'pasted.bib',
          recordCount: 1,
          normalizedPreview: [{ title: 'From BibTeX', authors: 'Doe, Jane', year: '2024', doi: '10.1/x' }],
        })
      }
      return jsonResponse({})
    })
    renderWithProviders(<AddPublicationPage />, { route: '/projects/p1/publications/add', path: '/projects/:projectId/publications/add' })

    fireEvent.click(screen.getByRole('button', { name: 'Prefill from BibTeX' }))
    fireEvent.change(screen.getByLabelText('Or paste BibTeX'), { target: { value: '@article{x, title={From BibTeX}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Prefill form' }))

    expect(await screen.findByLabelText('Title')).toHaveValue('From BibTeX')
    expect(screen.getByLabelText('Authors')).toHaveValue('Doe, Jane')
    expect(screen.getByLabelText('Year')).toHaveValue(2024)
    expect(screen.getByLabelText('DOI')).toHaveValue('10.1/x')
  })

  it('attaches an uploaded PDF to the publication after it is created', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/publications') && init?.method === 'POST') {
        return jsonResponse({ id: 'publication-1', title: 'A Manually Added Paper' }, 201)
      }
      if (url.endsWith('/publication-1/full-text')) {
        return jsonResponse({ available: true, document: { id: 'doc-1' } }, 201)
      }
      return jsonResponse({})
    })
    renderWithProviders(<AddPublicationPage />, { route: '/projects/p1/publications/add', path: '/projects/:projectId/publications/add' })

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Manually Added Paper' } })
    const pdf = new File(['pdf-bytes'], 'paper.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('PDF'), { target: { files: [pdf] } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Publication' }))

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find(([callInput]) => String(callInput).endsWith('/publication-1/full-text'))
      expect(uploadCall).toBeTruthy()
      expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData)
    })
    expect(await screen.findByText('Publication added.')).toBeInTheDocument()
  })
})
