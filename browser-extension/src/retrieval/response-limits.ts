/**
 * Bounded reading of untrusted publisher responses.
 *
 * A publisher response is arbitrary remote data: it can be gigabytes long,
 * declare a `Content-Length` that lies (or omit it entirely), or trickle
 * bytes forever without ever completing. Calling `response.arrayBuffer()`
 * or `response.text()` on one buffers the whole thing into the extension's
 * memory *before* any size limit can be applied, which turns a hostile or
 * merely broken publisher into a way to hang or kill the browser helper.
 *
 * So every body here is consumed through `response.body.getReader()`, with
 * the byte count checked as each chunk arrives and the stream cancelled the
 * moment the configured maximum is passed. `Content-Length` is still checked
 * first, but only as a cheap early rejection -- never as the limit itself.
 *
 * Timeouts are split deliberately:
 *
 * * {@link fetchWithTimeout} bounds the time until response *headers* arrive,
 *   via `AbortController`, and disarms once they do;
 * * the read loop bounds the gap between *body chunks* independently, so a
 *   response that starts promptly and then stalls forever is still cut off.
 */

/** Time allowed for a request to produce response headers. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Time allowed between two body chunks before the read is abandoned. */
export const DEFAULT_STALL_TIMEOUT_MS = 30_000
/** Cap for an HTML landing page -- generous for a publisher page, tiny next
 * to what an unbounded read would accept. */
export const MAX_LANDING_PAGE_BYTES = 5 * 1024 * 1024
/** Cap for the DOI Handle API's small JSON document. */
export const MAX_JSON_BYTES = 1024 * 1024

export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeds the maximum allowed size of ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

export class ResponseTimeoutError extends Error {
  constructor(message = 'Timed out waiting for the publisher response') {
    super(message)
    this.name = 'ResponseTimeoutError'
  }
}

interface ReadOptions {
  /** Maximum gap between body chunks. */
  stallTimeoutMs?: number
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ResponseTimeoutError()), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * `Content-Length` is advisory: it may be absent (chunked transfer) or
 * simply untrue. Treat a declared over-limit length as a reason to reject
 * before opening the body, and treat everything else as unknown.
 */
export function declaredLengthExceeds(response: Response, maxBytes: number): boolean {
  const header = response.headers.get('Content-Length')
  if (!header) return false
  const declared = Number(header)
  return Number.isFinite(declared) && declared > maxBytes
}

/**
 * Fetches with a bound on how long the request may take to produce headers.
 * The timer is cleared as soon as the response object exists -- the body is
 * then governed by the read loop's own stall timeout.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new ResponseTimeoutError('The request timed out')),
    timeoutMs,
  )
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function* limitedChunks(
  response: Response,
  maxBytes: number,
  options: ReadOptions,
): AsyncGenerator<Uint8Array> {
  if (declaredLengthExceeds(response, maxBytes)) {
    throw new ResponseTooLargeError(maxBytes)
  }
  const body = response.body
  // A null body means there is genuinely nothing to read (204/304, HEAD).
  // Falling back to `arrayBuffer()` here would reintroduce exactly the
  // unbounded buffering this module exists to prevent.
  if (!body) return

  const reader = body.getReader()
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  let total = 0
  try {
    for (;;) {
      const { value, done } = await withTimeout(reader.read(), stallTimeoutMs)
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        // Abort before this chunk is retained: an over-limit body is never
        // fully buffered, however large it turns out to be.
        throw new ResponseTooLargeError(maxBytes)
      }
      yield value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Reads a response body into memory, never exceeding `maxBytes`. */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  options: ReadOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of limitedChunks(response, maxBytes, options)) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Decodes a response body to text incrementally, never exceeding `maxBytes`.
 * The complete string is only ever built for a body that stayed within the
 * limit -- an oversized page throws part-way through instead.
 */
export async function readTextWithLimit(
  response: Response,
  maxBytes: number,
  options: ReadOptions = {},
): Promise<string> {
  const decoder = new TextDecoder('utf-8')
  let text = ''
  for await (const chunk of limitedChunks(response, maxBytes, options)) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}
