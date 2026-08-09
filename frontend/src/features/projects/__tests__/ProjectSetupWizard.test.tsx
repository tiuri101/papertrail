import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'

import { ProjectSetupWizard } from '../ProjectSetupWizard'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectSetupWizard', () => {
  it('creates a project from step 1 and advances to the research questions step', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url === '/api/v1/projects') {
        const body = JSON.parse(String(init.body))
        return jsonResponse({ id: 'p1', ...body, stage: 'draft' }, 201)
      }
      if (url === '/api/v1/projects/p1') {
        return jsonResponse({
          id: 'p1',
          name: 'Urban VR review',
          description: 'A review of urban VR studies',
          reviewType: 'systematic_mapping',
          researchQuestions: [],
          criteria: [],
        })
      }
      return jsonResponse({})
    })

    renderWithProviders(<ProjectSetupWizard />, { route: '/projects/new', path: '/projects/new' })

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Urban VR review' },
    })
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'A review of urban VR studies' },
    })
    fireEvent.change(screen.getByLabelText('Review type'), {
      target: { value: 'systematic_mapping' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create Project & Continue' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        name: 'Urban VR review',
        description: 'A review of urban VR studies',
        reviewType: 'systematic_mapping',
      })
    })

    expect(await screen.findByRole('heading', { name: 'Research Questions' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Project Name and Description' })).not.toBeInTheDocument()
  })

  it('lets a manager jump between steps and finish setup from an existing draft project', async () => {
    mockFetch(async (input) => {
      const url = String(input)
      if (url === '/api/v1/projects/p1') {
        return jsonResponse({
          id: 'p1',
          name: 'Existing draft',
          description: null,
          reviewType: 'other',
          memberships: [],
        })
      }
      if (url === '/api/v1/users') {
        return jsonResponse([
          { id: 'u1', displayName: 'Ada Lovelace', username: 'ada', isAdmin: false, isActive: true },
        ])
      }
      if (url === '/api/v1/projects/p1/llm/settings') {
        return jsonResponse({
          enabled: false,
          titleAbstractScreeningEnabled: false,
          fullTextScreeningEnabled: false,
          extractionValidationEnabled: false,
          installationEnabled: false,
          provider: 'ollama',
          endpoint: null,
          model: null,
          contextLength: 4096,
          currentSchemaVersionId: null,
        })
      }
      if (url === '/api/v1/projects/p1/llm/schema') {
        return jsonResponse({ schema: null, extractionFields: [] })
      }
      if (url.startsWith('/api/v1/projects/p1/llm/runs')) {
        return jsonResponse({
          total: 0,
          counts: {},
          statistics: { averageDuration: null, averagePromptTokens: null, averageGeneratedTokens: null },
          overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 },
          runs: [],
        })
      }
      return jsonResponse({})
    })

    renderWithProviders(
      <Routes>
        <Route path="/projects/:projectId/setup" element={<ProjectSetupWizard />} />
        <Route path="/projects/:projectId" element={<p>Project landing page</p>} />
      </Routes>,
      { route: '/projects/p1/setup' },
    )

    expect(await screen.findByText(/Setting up "Existing draft"/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reviewers/ }))
    expect(await screen.findByRole('heading', { name: 'Project Members' })).toBeInTheDocument()
    expect(await screen.findByText('Ada Lovelace (ada)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /LLM Assistance/ }))

    expect(await screen.findByRole('heading', { name: 'LLM Assistance' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Processing status' })).not.toBeInTheDocument()
    expect(screen.queryByText('Processing status')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }))

    expect(await screen.findByText('Project landing page')).toBeInTheDocument()
  })
})
