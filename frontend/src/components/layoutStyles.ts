export const toolbarClass = 'my-5 flex flex-wrap items-center gap-3 mb-0'

export const tableScrollClass = 'w-full overflow-x-auto'

/**
 * Replicates the base-element `table`/`th`/`td`/`tr`/`thead`/`tbody` rules formerly in
 * `base.css` as Tailwind arbitrary variants, applied on the `<table>` element itself.
 * Combine with `tableCompactClass`/`tableNarrowClass` or a call-site override via `cn()` —
 * those use `!` on the properties they intentionally override (padding, width, text-align,
 * vertical-align, header font size) because Tailwind v4 does not reliably resolve conflicting
 * same-property utilities by className/source order.
 */
export const tableBaseClass = [
  'w-full border-collapse border-spacing-0',
  '[&_th]:px-4 [&_th]:py-[13px] [&_th]:border-b [&_th]:border-border [&_th]:text-left [&_th]:align-top',
  '[&_td]:px-4 [&_td]:py-[13px] [&_td]:border-b [&_td]:border-border [&_td]:text-left [&_td]:align-top',
  '[&_tr:last-child>th]:border-b-0 [&_tr:last-child>td]:border-b-0',
  '[&_tbody_tr]:[transition:background-color_120ms_ease] [&_tbody_tr:hover]:bg-surface-hover',
  '[&_thead_th]:text-text-muted [&_thead_th]:text-[0.73rem] [&_thead_th]:font-[760] [&_thead_th]:tracking-[0.08em] [&_thead_th]:uppercase',
  '[&_tbody_th]:text-text-secondary [&_tbody_th]:font-[620]',
  'max-[480px]:[&_th]:px-2 max-[480px]:[&_th]:py-[10px] max-[480px]:[&_th]:text-[0.88rem]',
  'max-[480px]:[&_td]:px-2 max-[480px]:[&_td]:py-[10px] max-[480px]:[&_td]:text-[0.88rem]',
].join(' ')

/** Mobile fallback for a table with no scroll wrapper: matches the old `table:not([class])` rule. */
export const tableMobileScrollClass = 'max-[760px]:block max-[760px]:overflow-x-auto max-[760px]:whitespace-normal'

export const tableCompactClass = '[&_th]:px-3! [&_th]:py-2! [&_td]:px-3! [&_td]:py-2! [&_thead_th]:text-xs!'

export const tableNarrowClass = 'w-auto! min-w-0'
