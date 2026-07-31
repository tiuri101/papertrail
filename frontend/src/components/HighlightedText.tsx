function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const KEYWORD_COLOR_COUNT = 8

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

function keywordColorClass(keyword: string): string {
  return `mark-kw-${hashString(keyword.toLowerCase()) % KEYWORD_COLOR_COUNT}`
}

export function HighlightedText({ text, keywords }: { text: string; keywords: string[] }) {
  const cleaned = keywords.map((keyword) => keyword.trim()).filter(Boolean)
  if (!text || cleaned.length === 0) return <>{text}</>

  const sortedKeywords = [...cleaned].sort((a, b) => b.length - a.length)
  const pattern = sortedKeywords.map(escapeRegExp).join('|')
  const regex = new RegExp(`(${pattern})`, 'gi')
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        const keyword = sortedKeywords.find((candidate) => candidate.toLowerCase() === part.toLowerCase()) ?? part
        return (
          <mark key={index} className={keywordColorClass(keyword)}>
            {part}
          </mark>
        )
      })}
    </>
  )
}
