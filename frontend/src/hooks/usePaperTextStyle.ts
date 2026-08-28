import type { CSSProperties } from 'react'

import {
  DEFAULT_PAPER_TEXT_DISPLAY,
  PAPER_TEXT_DISPLAY_PREFERENCE_KEY,
  paperFontFamilyStack,
  paperFontSizeRem,
  paperTitleFontSizeRem,
  type PaperTextDisplay,
} from '../lib/paperTextDisplay'
import { useUiPreference } from './useUiPreferences'

/** The reviewer's chosen font/size for paper titles and abstracts, as inline styles. */
export function usePaperTextStyle(): { title: CSSProperties; abstract: CSSProperties } {
  const { value } = useUiPreference<PaperTextDisplay>(
    PAPER_TEXT_DISPLAY_PREFERENCE_KEY,
    DEFAULT_PAPER_TEXT_DISPLAY,
  )
  const fontFamily = paperFontFamilyStack(value.fontFamily)
  return {
    title: { fontFamily, fontSize: `${paperTitleFontSizeRem(value.fontSize)}rem` },
    abstract: { fontFamily, fontSize: `${paperFontSizeRem(value.fontSize)}rem` },
  }
}
