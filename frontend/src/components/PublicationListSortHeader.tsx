export function PublicationListSortHeader<TKey extends string>({
  label,
  sortKey,
  activeKey,
  direction,
  onToggle,
}: {
  label: string
  sortKey: TKey
  activeKey: TKey
  direction: 'asc' | 'desc'
  onToggle: (key: TKey) => void
}) {
  const active = sortKey === activeKey

  return (
    <button
      type="button"
      className="h-auto min-h-0 border-0 bg-transparent p-0 text-text-muted shadow-none hover:not-disabled:bg-transparent hover:not-disabled:text-text"
      aria-pressed={active}
      onClick={() => onToggle(sortKey)}
    >
      {label}{active ? (direction === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  )
}
