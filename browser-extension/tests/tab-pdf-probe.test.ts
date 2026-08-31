import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureCandidatePdfFromTab } from '../src/capture/tab-pdf-probe'

const PDF_BODY = '%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'
const MAX_BYTES = 10 * 1024 * 1024

function pdfResponse(): Response {
  return new Response(PDF_BODY, {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' },
  })
}

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('captureCandidatePdfFromTab', () => {
  it('fetches the citation_pdf_url meta tag from the live document', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf">'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://publisher.example.org/fulltext.pdf')
      return pdfResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('finds an anchor whose text reads "Download PDF" even without a .pdf href', async () => {
    document.body.innerHTML = `
      <div class="download-dropdown">
        <button>Download</button>
        <ul><li><a href="/1660-4601/18/3/939/pdf">Download PDF</a></li></ul>
      </div>
    `
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse()))

    const outcome = await captureCandidatePdfFromTab('https://www.mdpi.com/1660-4601/18/3/939', MAX_BYTES)

    expect(outcome.ok).toBe(true)
  })

  it('falls back to the MDPI article-path convention when no anchor matches at all', async () => {
    document.body.innerHTML = '<div class="download-dropdown"><button>Download</button></div>'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://www.mdpi.com/1660-4601/18/3/939/pdf')
      return pdfResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://www.mdpi.com/1660-4601/18/3/939', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not apply the MDPI fallback on other hosts', async () => {
    document.body.innerHTML = '<p>No download link here.</p>'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome).toEqual({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips a candidate whose response is not actually a PDF', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf">'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not a pdf</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })))

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(false)
  })

  it('gives up on a candidate that is rejected outright', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf">'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })))

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(false)
  })

  it('follows a meta-refresh redirect to the real PDF', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/pdf?v=1">'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://publisher.example.org/pdf?v=1') {
        return new Response(
          '<html><head><meta http-equiv="refresh" content="0;url=https://cdn.example.org/actual.pdf"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://cdn.example.org/actual.pdf') return pdfResponse()
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('follows a meta-refresh whose URL is single-quoted inside the double-quoted content attribute', async () => {
    // Mirrors MDPI's actual markup: content="5; URL='/path'" -- a naive
    // stop-at-any-quote parser can't see past the inner quote. Uses a
    // non-mdpi.com host so the only candidate is the citation meta tag,
    // keeping the redirect chain (and the fetch-count assertion) simple.
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/pdf?version=1">'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://publisher.example.org/pdf?version=1') {
        return new Response(
          '<html><head><meta http-equiv="refresh" content="0; URL=\'/pdf?version=2\'"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://publisher.example.org/pdf?version=2') return pdfResponse()
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits out a delayed meta-refresh before retrying, including a retry of the exact same URL', async () => {
    vi.useFakeTimers()
    try {
      document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/pdf">'
      let attempt = 0
      const fetchMock = vi.fn(async () => {
        attempt += 1
        if (attempt === 1) {
          return new Response(
            '<html><head><meta http-equiv="refresh" content="5; URL=\'/pdf\'"></head></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          )
        }
        return pdfResponse()
      })
      vi.stubGlobal('fetch', fetchMock)

      const outcomePromise = captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)
      await vi.advanceTimersByTimeAsync(5000)
      const outcome = await outcomePromise

      expect(outcome.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows a JavaScript location redirect to the real PDF', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/pdf?v=1">'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://publisher.example.org/pdf?v=1') {
        return new Response(
          '<html><body><script>window.location.href = "/actual.pdf";</script></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://publisher.example.org/actual.pdf') return pdfResponse()
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up when the response is neither a PDF nor a recognizable redirect', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/pdf?v=1">'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Please verify you are human to continue.</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )))

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(false)
  })

  it('returns the PDF bytes as base64', async () => {
    document.head.innerHTML = '<meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf">'
    vi.stubGlobal('fetch', vi.fn(async () => pdfResponse()))

    const outcome = await captureCandidatePdfFromTab('https://publisher.example.org/article/1', MAX_BYTES)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(atob(outcome.base64)).toBe(PDF_BODY)
      expect(outcome.contentType).toBe('application/pdf')
    }
  })
})
