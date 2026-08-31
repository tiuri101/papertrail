import { acmResolver } from './acm'
import { genericResolver } from './generic'
import { ieeeResolver } from './ieee'
import { mdpiResolver } from './mdpi'
import type { PdfResolver } from './resolver'
import { scienceDirectResolver } from './sciencedirect'
import { springerResolver } from './springer'

// Publisher-specific resolvers first; genericResolver.canHandle is always
// true, so it must stay last as the fallback.
export const resolvers: PdfResolver[] = [
  acmResolver,
  ieeeResolver,
  mdpiResolver,
  springerResolver,
  scienceDirectResolver,
  genericResolver,
]

export function resolverFor(context: { landingUrl: string; html: string; document: Document }): PdfResolver {
  return resolvers.find((resolver) => resolver.canHandle(context)) ?? genericResolver
}

export * from './resolver'
