import { describe, expect, it } from 'vitest'

import { validatePdfBytes, validatePdfResponse } from '../src/retrieval/pdf-validator'

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
}

describe('validatePdfBytes', () => {
  it('accepts a well-formed PDF', async () => {
    const bytes = bytesOf('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')
    const result = await validatePdfBytes(bytes, 'application/pdf', 1_000_000)
    expect(result.valid).toBe(true)
  })

  it('rejects HTML pretending to be a PDF', async () => {
    const bytes = bytesOf('<html><body>Please sign in</body></html>')
    const result = await validatePdfBytes(bytes, 'text/html', 1_000_000)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/PDF header/)
  })

  it('rejects an empty response', async () => {
    const result = await validatePdfBytes(bytesOf(''), 'application/pdf', 1_000_000)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/empty/)
  })

  it('rejects a response missing the %PDF- magic header', async () => {
    const bytes = bytesOf('this is not a pdf at all%%EOF')
    const result = await validatePdfBytes(bytes, 'application/pdf', 1_000_000)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/PDF header/)
  })

  it('rejects a response missing the %%EOF marker', async () => {
    const bytes = bytesOf('%PDF-1.4\nno end of file marker here')
    const result = await validatePdfBytes(bytes, 'application/pdf', 1_000_000)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/end-of-file/)
  })

  it('rejects a response larger than the maximum allowed size', async () => {
    const bytes = bytesOf(`%PDF-1.4\n${'a'.repeat(100)}\n%%EOF`)
    const result = await validatePdfBytes(bytes, 'application/pdf', 10)
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toMatch(/maximum PDF size/)
  })
})

describe('validatePdfResponse', () => {
  it('rejects based on a declared Content-Length before reading the body', async () => {
    const response = new Response(bytesOf('%PDF-1.4\n%%EOF'), {
      headers: { 'Content-Length': '999999999', 'Content-Type': 'application/pdf' },
    })
    const result = await validatePdfResponse(response, 1000)
    expect(result.valid).toBe(false)
  })

  it('accepts a valid PDF response', async () => {
    const response = new Response(bytesOf('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'), {
      headers: { 'Content-Type': 'application/pdf' },
    })
    const result = await validatePdfResponse(response, 1_000_000)
    expect(result.valid).toBe(true)
  })
})
