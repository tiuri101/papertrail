const CONTENT_DISPOSITION_FILENAME = /filename\*?=(?:UTF-8'')?"?([^";\r\n]+)"?/i
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(INVALID_FILENAME_CHARS, '_').trim()
  return cleaned.slice(0, 200)
}

/**
 * Picks a filename in the order the server (`stage_pdf_upload`) also
 * documents: Content-Disposition, then the final PDF URL, then a
 * publication-derived fallback. The server sanitizes again independently --
 * this only needs to produce something reasonable for a first pass.
 */
export function filenameFromResponse(
  response: Response,
  sourceUrl: string,
  publicationTitle: string,
): string {
  const disposition = response.headers.get('Content-Disposition')
  if (disposition) {
    const match = CONTENT_DISPOSITION_FILENAME.exec(disposition)
    if (match?.[1]) {
      let candidate = match[1]
      try {
        candidate = decodeURIComponent(candidate)
      } catch {
        // keep the raw value if it isn't validly percent-encoded
      }
      if (candidate.toLowerCase().endsWith('.pdf')) {
        const sanitized = sanitizeFilename(candidate)
        if (sanitized) return sanitized
      }
    }
  }

  try {
    const url = new URL(sourceUrl)
    const last = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    if (last.toLowerCase().endsWith('.pdf')) {
      const sanitized = sanitizeFilename(last)
      if (sanitized) return sanitized
    }
  } catch {
    // fall through to the title-based name
  }

  const sanitizedTitle = sanitizeFilename(publicationTitle)
  return sanitizedTitle ? `${sanitizedTitle}.pdf` : 'paper.pdf'
}
