export function CompletionBar({
  answered,
  total,
  label = 'answered',
}: {
  answered: number
  total: number
  label?: string
}) {
  const percent = total > 0 ? Math.round((answered / total) * 100) : 0
  return (
    <div className="completion-bar">
      <div className="completion-bar__track">
        <div className="completion-bar__fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="completion-bar__label muted">
        {answered} of {total} {label} ({percent}%)
      </span>
    </div>
  )
}
