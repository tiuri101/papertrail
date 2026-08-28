import { CollapsibleSection } from './CollapsibleSection'
import { IconHighlighter } from './icons'
import { Select } from './Select'
import { FieldLabel } from './FieldLabel'
import { useUiPreference } from '../hooks/useUiPreferences'
import {
  DEFAULT_PAPER_TEXT_DISPLAY,
  PAPER_FONT_FAMILY_OPTIONS,
  PAPER_FONT_SIZE_OPTIONS,
  PAPER_TEXT_DISPLAY_PREFERENCE_KEY,
  paperFontFamilyStack,
  paperFontSizeRem,
  paperTitleFontSizeRem,
  type PaperFontFamily,
  type PaperFontSize,
  type PaperTextDisplay,
} from '../lib/paperTextDisplay'

export function PaperTextDisplaySection() {
  const { value, setValue, isSaving, error } = useUiPreference<PaperTextDisplay>(
    PAPER_TEXT_DISPLAY_PREFERENCE_KEY,
    DEFAULT_PAPER_TEXT_DISPLAY,
  )

  return (
    <CollapsibleSection id="section-account-paper-text" title="Title & Abstract Display" icon={<IconHighlighter />}>
      <p className="text-text-muted">
        Choose the font and size used for paper titles and abstracts while screening, extracting
        data, and doing quality assessment.
      </p>
      <div className="flex flex-wrap gap-4">
        <FieldLabel>
          Font
          <Select
            value={value.fontFamily}
            onChange={(event) => setValue({ ...value, fontFamily: event.target.value as PaperFontFamily })}
          >
            {PAPER_FONT_FAMILY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel>
          Size
          <Select
            value={value.fontSize}
            onChange={(event) => setValue({ ...value, fontSize: event.target.value as PaperFontSize })}
          >
            {PAPER_FONT_SIZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
        </FieldLabel>
      </div>
      <div className="rounded-md border border-border bg-bg-elevated px-4 py-3">
        <p
          className="font-semibold"
          style={{ fontFamily: paperFontFamilyStack(value.fontFamily), fontSize: `${paperTitleFontSizeRem(value.fontSize)}rem` }}
        >
          Example paper title
        </p>
        <p
          className="mt-2"
          style={{ fontFamily: paperFontFamilyStack(value.fontFamily), fontSize: `${paperFontSizeRem(value.fontSize)}rem` }}
        >
          Example abstract text, shown smaller than the title above.
        </p>
      </div>
      {error ? <p className="text-danger" role="alert">{error.message}</p> : null}
      <p className="text-text-muted" aria-live="polite">{isSaving ? 'Saving…' : ' '}</p>
    </CollapsibleSection>
  )
}
