import { IconCheckCircle } from '../../components/icons'
import type { DuplicateChoice } from './types'

const BASE_BUTTON =
  'flex min-h-0 w-full min-w-0 items-center justify-start gap-3 rounded-md border bg-bg-elevated px-4 py-3 text-left text-text-secondary shadow-none hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 min-[681px]:min-h-[4.25rem]'

/**
 * The three-way duplicate decision control — keep Record A, keep Record B, or
 * mark the pair distinct. Shared by the review queue (fresh decision) and the
 * decisions page (change an existing decision, where `current` marks the
 * choice already on record).
 */
export function DuplicateDecisionButtons({
  onMerge,
  onNotDuplicate,
  publicationAId,
  publicationBId,
  disabled = false,
  current,
  recommended,
  headline = 'Your Decision',
  hint = 'Select the record to keep, or confirm that these publications are distinct.',
}: {
  onMerge: (canonicalPublicationId: string) => void
  onNotDuplicate: () => void
  publicationAId: string
  publicationBId: string
  disabled?: boolean
  current?: DuplicateChoice
  /** Provider-suggested choice — marked with a "Suggested" hint, but only when
   * it is not already the choice on record. */
  recommended?: DuplicateChoice
  headline?: string
  hint?: string
}) {
  const edge = (choice: DuplicateChoice, hover: string) => {
    const state =
      current === choice
        ? 'border-primary bg-primary-container'
        : recommended === choice
          ? 'border-primary/60 ring-1 ring-primary/30'
          : 'border-border'
    return `${BASE_BUTTON} ${hover} ${state}`
  }

  const SuggestedTag = ({ choice }: { choice: DuplicateChoice }) =>
    recommended === choice && current !== choice ? (
      <span className="ml-auto shrink-0 rounded-full bg-primary-container px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.04em] text-primary">
        Suggested
      </span>
    ) : null

  return (
    <section className="border-t border-border bg-surface-raised/50 p-4 min-[681px]:p-5" aria-label="Duplicate decision">
      <div>
        <h3 className="m-0">{headline}</h3>
        <p className="mb-0 mt-1 text-[0.86rem] text-text-muted">{hint}</p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 min-[681px]:grid-cols-3">
        <button
          type="button"
          className={edge('a', 'hover:border-[var(--kw-1-fg)]')}
          aria-label="Keep Record A"
          aria-pressed={current === 'a'}
          onClick={() => onMerge(publicationAId)}
          disabled={disabled}
        >
          <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-1-fg)_62%,var(--color-border))] text-[var(--kw-1-fg)] [&_svg]:size-[0.8rem] [&_svg]:fill-current"><IconCheckCircle /></span>
          <span className="grid min-w-0 gap-1">
            <strong className="text-text">Keep Record A</strong>
            <small className="text-[0.78rem] font-medium text-text-muted">Merge Record B into A</small>
          </span>
          <SuggestedTag choice="a" />
        </button>
        <button
          type="button"
          className={edge('b', 'hover:border-[var(--kw-4-fg)]')}
          aria-label="Keep Record B"
          aria-pressed={current === 'b'}
          onClick={() => onMerge(publicationBId)}
          disabled={disabled}
        >
          <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-4-fg)_62%,var(--color-border))] text-[var(--kw-4-fg)] [&_svg]:size-[0.8rem] [&_svg]:fill-current"><IconCheckCircle /></span>
          <span className="grid min-w-0 gap-1">
            <strong className="text-text">Keep Record B</strong>
            <small className="text-[0.78rem] font-medium text-text-muted">Merge Record A into B</small>
          </span>
          <SuggestedTag choice="b" />
        </button>
        <button
          type="button"
          className={edge('not_duplicate', 'hover:border-border-strong')}
          aria-label="Not a Duplicate"
          aria-pressed={current === 'not_duplicate'}
          onClick={onNotDuplicate}
          disabled={disabled}
        >
          <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-border-strong text-text-muted" aria-hidden="true" />
          <span className="grid min-w-0 gap-1">
            <strong className="text-text">Not a Duplicate</strong>
            <small className="text-[0.78rem] font-medium text-text-muted">Keep both records separate</small>
          </span>
          <SuggestedTag choice="not_duplicate" />
        </button>
      </div>
    </section>
  )
}
