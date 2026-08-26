import type { RefObject, ReactNode } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'

import { DoiPill } from '../../components/DoiPill'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { fullTextDocumentEndpoint, type FullTextDocumentState } from '../fulltext/useFullTextDocument'
import type { PublicationSummary } from '../publications/types'
import { Button } from '../../components/Button'

/**
 * Publication title/authors, PDF/DOI/publisher pills, and the "Open PDF" link shared by the
 * extraction and quality workspaces' page chrome. `afterAuthors` is a slot for content that only
 * one workspace renders (e.g. extraction's "independent extraction N of M" notice) — kept as a
 * caller-supplied node rather than a prop flag so this component stays free of domain knowledge.
 */
export function ReviewPublicationHeader({
  titleRef,
  projectId,
  publicationId,
  publication,
  fullTextDocument,
  afterAuthors,
}: {
  titleRef: RefObject<HTMLHeadingElement | null>
  projectId: string
  publicationId: string
  publication: PublicationSummary
  fullTextDocument: UseQueryResult<FullTextDocumentState>
  afterAuthors?: ReactNode
}) {
  return (
    <>
      <h2 ref={titleRef} className="scroll-mt-[92px]">{publication.title}</h2>
      <p className="text-text">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      </p>
      {afterAuthors}
      <div className="toolbar flex flex-wrap items-center gap-3 my-5 max-[760px]:gap-2">
        {fullTextDocument.data ? (
          <PdfAvailabilityPill
            available={fullTextDocument.data.available}
            href={`${fullTextDocumentEndpoint(projectId, publicationId)}/content`}
            pageCount={fullTextDocument.data.document?.pageCount}
          />
        ) : null}
        <DoiPill doi={publication.doi} />
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <PublisherLinkPill url={publication.publisherUrl} />
        ) : null}
      </div>
      {fullTextDocument.data?.available ? (
        <Button
          as="a"
          variant="primary"
          size="sm"
          href={`${fullTextDocumentEndpoint(projectId, publicationId)}/content`}
          target="_blank"
          rel="noreferrer"
        >
          Open PDF
        </Button>
      ) : null}
    </>
  )
}
