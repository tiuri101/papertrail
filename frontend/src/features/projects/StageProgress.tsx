export const STAGES = [
  { value: 'draft', label: 'Draft', color: '#2a78d6' },
  { value: 'duplicate_review', label: 'Duplicate Review', color: '#eb6834' },
  { value: 'title_abstract_screening', label: 'Title/Abstract Screening', color: '#1baf7a' },
  { value: 'full_text_screening', label: 'Full-Text Screening', color: '#eda100' },
  { value: 'extraction_quality', label: 'Extraction & Quality', color: '#e87ba4' },
  { value: 'completed', label: 'Completed', color: '#008300' },
] as const

export function StageProgress({ stage }: { stage: string }) {
  return (
    <div className="stage-steps-wrap">
      <ol className="stage-steps" aria-label="Project stage">
        {STAGES.map((step) => (
          <li
            key={step.value}
            className="stage-step"
            style={{ backgroundColor: step.color }}
            aria-current={step.value === stage ? 'step' : undefined}
          >
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  )
}
