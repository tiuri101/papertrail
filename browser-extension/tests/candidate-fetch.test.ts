import { afterEach, describe, expect, it, vi } from 'vitest'

import { tryPdfCandidates } from '../src/retrieval/candidate-fetch'
import type { PdfCandidate } from '../src/resolvers/resolver'
import { installChromeMock } from './chrome-mock'

const PDF_BODY = '%PDF-1.4\n%%EOF'

function candidate(url: string): PdfCandidate {
  return { url, confidence: 90, source: 'test' }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tryPdfCandidates', () => {
  it('returns the first candidate that resolves to a non-HTML response', async () => {
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PDF_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    })))

    const outcome = await tryPdfCandidates([candidate('https://publisher.example.org/fulltext.pdf')], { delayMs: 0 })

    expect(outcome).toEqual({
      status: 'found',
      response: expect.any(Response),
      finalUrl: 'https://publisher.example.org/fulltext.pdf',
    })
  })

  it('reports needs_authentication when a candidate is a login/paywall page', async () => {
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'Please sign in via your institution to continue',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )))

    const outcome = await tryPdfCandidates([candidate('https://publisher.example.org/pdfft')], { delayMs: 0 })

    expect(outcome.status).toBe('needs_authentication')
  })

  it('skips a candidate outside granted permission and reports not_found', async () => {
    installChromeMock({ permissionsContains: async () => false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await tryPdfCandidates([candidate('https://publisher.example.org/fulltext.pdf')], { delayMs: 0 })

    expect(outcome).toEqual({ status: 'not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('moves on to the next candidate when one is an ordinary (non-paywall) HTML page', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://publisher.example.org/not-a-pdf') {
        return new Response('<html>just a page</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      if (url === 'https://publisher.example.org/fulltext.pdf') {
        return new Response(PDF_BODY, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await tryPdfCandidates([
      candidate('https://publisher.example.org/not-a-pdf'),
      candidate('https://publisher.example.org/fulltext.pdf'),
    ], { delayMs: 0 })

    expect(outcome.status).toBe('found')
  })

  it('returns not_found when no candidates remain', async () => {
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))

    const outcome = await tryPdfCandidates([candidate('https://publisher.example.org/missing.pdf')], { delayMs: 0 })

    expect(outcome).toEqual({ status: 'not_found' })
  })
})
