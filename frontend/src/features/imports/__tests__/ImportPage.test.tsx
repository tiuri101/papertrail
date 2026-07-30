import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImportPage } from '../ImportPage'
import { setCsrfToken } from '../../auth/session'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ImportPage', () => {
  it('uploads a bibliographic file with credentials and CSRF protection', async () => {
    setCsrfToken('csrf-import')
    const fetchMock = mockFetch(() => jsonResponse({ jobId: 'job-42' }, 202))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    const file = new File(['Title,Authors\nPaper,Author'], 'records.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Bibliographic export'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText('Import queued: job-42')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/projects/project-1/imports')
    expect(init?.credentials).toBe('include')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-import')
    expect(init?.body).toBeInstanceOf(FormData)
  })

  it('shows the server-provided import error', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Unsupported file format' } }, 415))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    fireEvent.change(screen.getByLabelText('Bibliographic export'), {
      target: { files: [new File(['bad'], 'records.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unsupported file format'))
  })
})
