function DocPile({
  x,
  y,
  rotate = 0,
  scale = 1,
  opacity = 1,
}: {
  x: number
  y: number
  rotate?: number
  scale?: number
  opacity?: number
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`} opacity={opacity}>
      <rect x="-26" y="-32" width="52" height="64" rx="7" fill="var(--color-surface-raised)" stroke="var(--color-border)" strokeWidth="1.5" />
      <rect x="-18" y="-24" width="14" height="14" rx="3" fill="var(--color-primary)" opacity="0.5" />
      <path d="M1 -17h13M-18 -3h32M-18 5h32M-18 13h20" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
    </g>
  )
}

export function DecorativeDocTrail({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 260 520" fill="none" aria-hidden="true">
      <path
        d="M75 100 C 130 130 150 150 198 193 C 232 228 148 262 128 318 C 110 362 68 380 95 414 C 116 440 132 452 146 464"
        stroke="var(--color-primary)"
        strokeWidth="2.5"
        strokeDasharray="1 11"
        strokeLinecap="round"
        opacity="0.55"
      />

      <DocPile x={64} y={96} rotate={-11} opacity={0.4} />
      <DocPile x={86} y={90} rotate={7} opacity={0.7} />
      <DocPile x={75} y={80} rotate={-2} opacity={1} />

      <circle cx="220" cy="150" r="3" fill="var(--color-primary)" opacity="0.5" />
      <DocPile x={166} y={206} rotate={-15} opacity={0.32} />
      <DocPile x={212} y={216} rotate={11} opacity={0.48} />
      <DocPile x={179} y={178} rotate={-4} opacity={0.75} />
      <DocPile x={200} y={192} rotate={8} scale={1.1} opacity={1} />

      <path d="M40 250 l5 5 l5 -5 l-5 -5 Z" fill="var(--color-primary)" opacity="0.4" />
      <DocPile x={108} y={330} rotate={-9} opacity={0.5} />
      <DocPile x={128} y={312} rotate={5} opacity={0.95} />

      <circle cx="52" cy="382" r="10" stroke="var(--color-primary)" strokeWidth="2" opacity="0.3" />
      <DocPile x={95} y={410} rotate={-3} opacity={1} />

      <circle cx="150" cy="466" r="38" fill="var(--color-primary)" opacity="0.16" />
      <circle cx="150" cy="466" r="24" fill="var(--color-primary)" />
      <path d="M140 466 l7 7 l14 -15" stroke="var(--color-primary-contrast)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
