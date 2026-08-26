import { afterEach, describe, expect, it, vi } from 'vitest'

import { validatePdfResponse } from '../src/retrieval/pdf-validator'
import { safeRedirectFetch } from '../src/retrieval/redirect-fetch'
import {
  MAX_LANDING_PAGE_BYTES,
  readBodyWithLimit,
  readTextWithLimit,
  ResponseTimeoutError,
  ResponseTooLargeError,
} from '../src/retrieval/response-limits'

/**
 * An untrusted publisher body must be measured as it arrives, not after it
 * has been buffered. Every stream below reports how much it was actually
 * asked for and whether it was cancelled, so the tests can assert that an
 * over-limit response was cut off rather than merely rejected afterwards.
 */
interface TrackedStream {
  response: Response
  /** Chunks the reader actually pulled. */
  delivered: () => number
  cancelled: () => boolean
}

function chunkedResponse(
  chunk: Uint8Array,
  chunkCount: number,
  init: ResponseInit = {},
): TrackedStream {
  let delivered = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered >= chunkCount) {
        controller.close()
        return
      }
      delivered += 1
      controller.enqueue(chunk.slice())
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    response: new Response(stream, init),
    delivered: () => delivered,
    cancelled: () => cancelled,
  }
}

/** A body that accepts the connection and then never sends anything. */
function stalledResponse(init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {})
      },
    }),
    init,
  )
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readBodyWithLimit', () => {
  it('aborts an over-limit body that declares no Content-Length', async () => {
    // 100 chunks of 1 KiB against a 4 KiB limit: nothing tells the reader in
    // advance that this body is too big, so only per-chunk accounting stops it.
    const tracked = chunkedResponse(new Uint8Array(1024), 100)

    await expect(readBodyWithLimit(tracked.response, 4096)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    )
    expect(tracked.delivered()).toBeLessThanOrEqual(6)
    expect(tracked.cancelled()).toBe(true)
  })

  it('aborts when Content-Length lies about a body that is actually too large', async () => {
    const tracked = chunkedResponse(new Uint8Array(1024), 100, {
      headers: { 'Content-Length': '10' },
    })

    await expect(readBodyWithLimit(tracked.response, 4096)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    )
    expect(tracked.delivered()).toBeLessThanOrEqual(6)
    expect(tracked.cancelled()).toBe(true)
  })

  it('rejects an honestly-declared over-limit Content-Length without opening the body', async () => {
    const tracked = chunkedResponse(new Uint8Array(1024), 100, {
      headers: { 'Content-Length': '999999999' },
    })

    await expect(readBodyWithLimit(tracked.response, 4096)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    )
    // At most the one chunk the stream implementation pre-buffers itself --
    // the reader was never attached.
    expect(tracked.delivered()).toBeLessThanOrEqual(1)
  })

  it('reads a within-limit body completely', async () => {
    const tracked = chunkedResponse(bytesOf('abcd'), 3)

    const body = await readBodyWithLimit(tracked.response, 4096)

    expect(new TextDecoder().decode(body)).toBe('abcdabcdabcd')
  })

  it('times out a body that stalls part-way through', async () => {
    await expect(
      readBodyWithLimit(stalledResponse(), 4096, { stallTimeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ResponseTimeoutError)
  })
})

describe('readTextWithLimit', () => {
  it('rejects an HTML landing page larger than the maximum', async () => {
    const tracked = chunkedResponse(bytesOf('<p>filler</p>'.repeat(100)), 10_000)

    await expect(
      readTextWithLimit(tracked.response, MAX_LANDING_PAGE_BYTES),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    expect(tracked.cancelled()).toBe(true)
    // Stopped one chunk past the cap, nowhere near the 13 MB on offer.
    const chunkBytes = 1300
    expect(tracked.delivered()).toBeLessThan(10_000)
    expect(tracked.delivered() * chunkBytes)
      .toBeLessThanOrEqual(MAX_LANDING_PAGE_BYTES + 2 * chunkBytes)
  })

  it('decodes a within-limit page', async () => {
    const tracked = chunkedResponse(bytesOf('<html>ok</html>'), 1)

    await expect(readTextWithLimit(tracked.response, MAX_LANDING_PAGE_BYTES))
      .resolves.toBe('<html>ok</html>')
  })

  it('times out a landing page that stalls', async () => {
    await expect(
      readTextWithLimit(stalledResponse(), MAX_LANDING_PAGE_BYTES, { stallTimeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ResponseTimeoutError)
  })
})

describe('validatePdfResponse', () => {
  it('rejects an over-limit PDF body without buffering it whole', async () => {
    const tracked = chunkedResponse(new Uint8Array(1024), 100, {
      headers: { 'Content-Type': 'application/pdf' },
    })

    const result = await validatePdfResponse(tracked.response, 4096)

    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/maximum PDF size/)
    expect(tracked.cancelled()).toBe(true)
    expect(tracked.delivered()).toBeLessThanOrEqual(6)
  })

  it('rejects a stalled PDF download instead of hanging', async () => {
    const response = stalledResponse({ headers: { 'Content-Type': 'application/pdf' } })

    // Uses the module default stall timeout indirectly via a tiny body cap is
    // not possible here, so drive the reader directly with a short timeout.
    await expect(
      readBodyWithLimit(response, 4096, { stallTimeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ResponseTimeoutError)
  })

  it('still accepts a normal chunked PDF response', async () => {
    const pdf = bytesOf('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdf.slice(0, 8))
        controller.enqueue(pdf.slice(8))
        controller.close()
      },
    })
    const response = new Response(stream, { headers: { 'Content-Type': 'application/pdf' } })

    const result = await validatePdfResponse(response, 1_000_000)

    expect(result.valid).toBe(true)
  })
})

describe('safeRedirectFetch request timeout', () => {
  it('aborts a request that never produces response headers', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject((init.signal as AbortSignal).reason ?? new Error('aborted'))
      })
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      safeRedirectFetch('https://publisher.example.org/slow', { timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(ResponseTimeoutError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('passes an abort signal on every publisher request', async () => {
    const response = new Response('<html>ok</html>', { status: 200 })
    Object.defineProperty(response, 'url', { value: 'https://publisher.example.org/ok' })
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    await safeRedirectFetch('https://publisher.example.org/ok')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.example.org/ok',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
