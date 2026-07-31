function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function HighlightedText({ text, keywords }: { text: string; keywords: string[] }) {
  const cleaned = keywords.map((keyword) => keyword.trim()).filter(Boolean)
  if (!text || cleaned.length === 0) return <>{text}</>

  const pattern = [...cleaned]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}
    </>
  )
}
