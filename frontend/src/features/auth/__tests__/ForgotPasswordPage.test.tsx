import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ForgotPasswordPage } from '../ForgotPasswordPage'
import { jsonResponse, emptyResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderForgotPassword() {
  return renderWithProviders(
    <Routes>
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/login" element={<p>Login destination</p>} />
    </Routes>,
    { route: '/forgot-password' },
  )
}

describe('ForgotPasswordPage', () => {
  it('submits the email and shows a generic confirmation message', async () => {
    const fetchMock = mockFetch(() => emptyResponse())
    renderForgotPassword()

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'reviewer@example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'If an account exists for that email address',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/forgot-password',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: 'reviewer@example.org',
    })
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument()
  })

  it('shows the API error when the request is rate limited', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Too many password reset requests. Try again later.' } }, 429))
    renderForgotPassword()

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'reviewer@example.org' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Too many password reset requests'))
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
  })

  it('links back to the login page', () => {
    renderForgotPassword()

    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login')
  })
})
