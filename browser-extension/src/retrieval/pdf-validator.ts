const PDF_MAGIC = '%PDF-'
const PDF_EOF_MARKER = '%%EOF'
const HEAD_SCAN_BYTES = 1024
const TAIL_SCAN_BYTES = 4096

export type PdfValidationResult =
  | { valid: true; blob: Blob }
  | { valid: false; reason: string }

/**
 * Client-side validation, mirroring (but not replacing) the server's own
 * checks: this is only an early rejection so a login page or error body is
 * never uploaded as if it were a PDF. FastAPI performs the authoritative
 * validation again on upload.
 */
export async function validatePdfBytes(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string | null,
  maxBytes: number,
): Promise<PdfValidationResult> {
  if (bytes.byteLength === 0) {
    return { valid: false, reason: 'Response is empty' }
  }
  if (bytes.byteLength > maxBytes) {
    return { valid: false, reason: 'Response exceeds the maximum PDF size' }
  }

  const decoder = new TextDecoder('latin1')
  const head = decoder.decode(bytes.slice(0, HEAD_SCAN_BYTES))
  if (!head.trimStart().startsWith(PDF_MAGIC)) {
    return { valid: false, reason: 'Response does not start with a PDF header' }
  }

  const tail = decoder.decode(bytes.slice(Math.max(0, bytes.byteLength - TAIL_SCAN_BYTES)))
  if (!tail.includes(PDF_EOF_MARKER)) {
    return { valid: false, reason: 'Response is missing a PDF end-of-file marker' }
  }

  if (contentType && !contentType.includes('pdf') && !contentType.includes('octet-stream')) {
    return { valid: false, reason: `Unexpected content type for a PDF: ${contentType}` }
  }

  return { valid: true, blob: new Blob([bytes], { type: 'application/pdf' }) }
}

export async function validatePdfResponse(
  response: Response,
  maxBytes: number,
): Promise<PdfValidationResult> {
  const contentLengthHeader = response.headers.get('Content-Length')
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return { valid: false, reason: 'Response exceeds the maximum PDF size' }
    }
  }
  const buffer = await response.arrayBuffer()
  return validatePdfBytes(new Uint8Array(buffer), response.headers.get('Content-Type'), maxBytes)
}
