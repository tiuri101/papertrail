import { describe, expect, it } from 'vitest'

import { isSafePapertrailServerUrl, isSafePublisherUrl } from '../src/retrieval/url-safety'

describe('isSafePublisherUrl', () => {
  it('accepts normal public HTTPS publisher URLs', () => {
    expect(isSafePublisherUrl('https://link.springer.com/article/10.1007/s00000-000-0000-0')).toBe(true)
    expect(isSafePublisherUrl('https://dl.acm.org/doi/10.1145/1234567')).toBe(true)
    expect(isSafePublisherUrl('https://doi.org/10.1000/xyz123')).toBe(true)
  })

  it('rejects non-HTTPS schemes', () => {
    expect(isSafePublisherUrl('file:///etc/passwd')).toBe(false)
    expect(isSafePublisherUrl('javascript:alert(1)')).toBe(false)
    expect(isSafePublisherUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafePublisherUrl('chrome://settings')).toBe(false)
    expect(isSafePublisherUrl('chrome-extension://abc/page.html')).toBe(false)
    expect(isSafePublisherUrl('ftp://example.org/file.pdf')).toBe(false)
    expect(isSafePublisherUrl('http://example.org/paper.pdf')).toBe(false)
  })

  it('rejects localhost and loopback as a publisher target', () => {
    expect(isSafePublisherUrl('https://localhost/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://sub.localhost/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://127.0.0.1/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://[::1]/paper.pdf')).toBe(false)
  })

  it('rejects private IPv4 literals', () => {
    expect(isSafePublisherUrl('https://10.0.0.5/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://172.16.0.5/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://192.168.1.5/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://169.254.1.5/paper.pdf')).toBe(false)
  })

  it('rejects IPv4-mapped IPv6 loopback/private addresses', () => {
    // The URL parser normalizes ::ffff:127.0.0.1 to this hex form.
    expect(isSafePublisherUrl('https://[::ffff:7f00:1]/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://[::ffff:127.0.0.1]/paper.pdf')).toBe(false)
    // ::ffff:a9fe:101 == ::ffff:169.254.1.1 (link-local, e.g. cloud metadata)
    expect(isSafePublisherUrl('https://[::ffff:a9fe:101]/paper.pdf')).toBe(false)
    expect(isSafePublisherUrl('https://[::ffff:c0a8:15]/paper.pdf')).toBe(false)
  })

  it('rejects URLs with embedded credentials', () => {
    expect(isSafePublisherUrl('https://user:pass@example.org/paper.pdf')).toBe(false)
  })

  it('rejects unparseable URLs', () => {
    expect(isSafePublisherUrl('not a url')).toBe(false)
    expect(isSafePublisherUrl('')).toBe(false)
  })
})

describe('isSafePapertrailServerUrl', () => {
  it('accepts HTTPS servers', () => {
    expect(isSafePapertrailServerUrl('https://papertrail.example.org')).toBe(true)
  })

  it('allows HTTP only for local development URLs', () => {
    expect(isSafePapertrailServerUrl('http://localhost:5173')).toBe(true)
    expect(isSafePapertrailServerUrl('http://127.0.0.1:8000')).toBe(true)
    expect(isSafePapertrailServerUrl('http://papertrail.example.org')).toBe(false)
  })

  it('rejects embedded credentials and unparseable URLs', () => {
    expect(isSafePapertrailServerUrl('https://user:pass@papertrail.example.org')).toBe(false)
    expect(isSafePapertrailServerUrl('not a url')).toBe(false)
  })
})
