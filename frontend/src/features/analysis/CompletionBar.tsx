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
    <div className="grid gap-1">
      <div
        className="h-2 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={`${label} completion`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={answered}
      >
        <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-[0.82rem] text-text-muted">
        {answered} of {total} {label} ({percent}%)
      </span>
    </div>
  )
}
