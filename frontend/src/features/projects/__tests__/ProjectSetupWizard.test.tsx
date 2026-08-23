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
    const backButton = screen.getByRole('button', { name: 'Back' })
    const nextButton = screen.getByRole('button', { name: 'Next' })
    const controls = backButton.parentElement!
    const finishLater = screen.getByRole('link', { name: 'Finish later' })
    expect(controls).toContainElement(nextButton)
    expect(controls.nextElementSibling).toBe(finishLater)
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
      if (url === '/api/v1/projects/p1/extraction-config') {
        return jsonResponse({ allocationMode: 'claim', requiredReviewers: 1 })
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

    fireEvent.click(screen.getByRole('button', { name: /Extraction Form/ }))
    expect(await screen.findByRole('heading', { name: 'Extraction Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Data Extraction Form' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /LLM Assistance/ }))

    expect(await screen.findByRole('heading', { name: 'LLM Installation' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Processing Status' })).not.toBeInTheDocument()
    expect(screen.queryByText('Processing Status')).not.toBeInTheDocument()

    const finishButton = screen.getByRole('button', { name: 'Finish Setup' })
    const finishControls = finishButton.parentElement!
    expect(finishControls).toContainElement(screen.getByRole('button', { name: 'Back' }))
    expect(finishControls.nextElementSibling).toBe(screen.getByRole('link', { name: 'Finish later' }))
    fireEvent.click(finishButton)

    expect(await screen.findByText('Project landing page')).toBeInTheDocument()
  })

  it('saves and publishes the LLM schema through Finish Setup without showing version controls', async () => {
    const schema = {
      id: 'schema-1',
      versionNumber: 1,
      status: 'draft',
      fields: [{
        id: 'field-1',
        stableKey: 'outcome',
        label: 'Outcome',
        instruction: 'Extract the reported outcome.',
        fieldType: 'short_text',
        mappedExtractionFieldKey: 'outcome',
        options: [],
        evidenceRequired: true,
        allowInferred: false,
        enabled: true,
        position: 0,
        mappingState: 'active',
      }],
    }
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url === '/api/v1/projects/p1') {
        return jsonResponse({ id: 'p1', name: 'LLM setup', description: null, reviewType: 'other' })
      }
      if (url === '/api/v1/projects/p1/llm/settings') {
        return jsonResponse({
          enabled: true,
          titleAbstractScreeningEnabled: false,
          fullTextScreeningEnabled: false,
          extractionValidationEnabled: false,
          installationEnabled: true,
          provider: 'ollama',
          endpoint: null,
          model: 'test-model',
          contextLength: 4096,
          currentSchemaVersionId: null,
        })
      }
      if (url === '/api/v1/projects/p1/llm/schema/schema-1' && init?.method === 'PUT') {
        return jsonResponse({ ...schema, fields: JSON.parse(String(init.body)).fields })
      }
      if (url === '/api/v1/projects/p1/llm/schema/schema-1/publish' && init?.method === 'POST') {
        return jsonResponse({ ...schema, status: 'published' })
      }
      if (url === '/api/v1/projects/p1/llm/schema') {
        return jsonResponse({
          schema,
          extractionFields: [{ stableKey: 'outcome', label: 'Outcome', fieldType: 'short_text', options: [] }],
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

    fireEvent.click(await screen.findByRole('button', { name: /LLM Assistance/ }))
    expect(await screen.findByText('Version 1 · draft')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish version' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Extraction instruction'), {
      target: { value: 'Extract the primary reported outcome.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Finish Setup' }))

    expect(await screen.findByText('Project landing page')).toBeInTheDocument()
    const putCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input) === '/api/v1/projects/p1/llm/schema/schema-1' && init?.method === 'PUT'
    ))
    expect(JSON.parse(String(putCall?.[1]?.body)).fields[0].instruction)
      .toBe('Extract the primary reported outcome.')
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === '/api/v1/projects/p1/llm/schema/schema-1/publish' && init?.method === 'POST'
    ))).toBe(true)
  })
})
