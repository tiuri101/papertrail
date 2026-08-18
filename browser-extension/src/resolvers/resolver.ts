export interface PdfCandidate {
  url: string
  /** Higher is better; used only to order candidates for the engine to try. */
  confidence: number
  source: string
}

export interface ResolverContext {
  landingUrl: string
  html: string
  document: Document
}

export interface PdfResolver {
  name: string
  canHandle(context: ResolverContext): boolean
  discover(context: ResolverContext): PdfCandidate[]
}
