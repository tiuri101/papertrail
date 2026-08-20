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
      className="link-button publication-list__sort-button"
      aria-pressed={active}
      onClick={() => onToggle(sortKey)}
    >
      {label}{active ? (direction === 'asc' ? ' ▲' : ' ▼') : ''}
    </button>
  )
}
