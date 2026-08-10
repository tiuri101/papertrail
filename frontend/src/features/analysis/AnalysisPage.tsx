import { useParams } from 'react-router-dom'

import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateReviewSection } from './DuplicateReviewSection'
import { ExtractionQualitySection } from './ExtractionQualitySection'
import { FullTextSection } from './FullTextSection'
import { TitleAbstractSection } from './TitleAbstractSection'

const analysisSections = [
  { id: 'section-analysis-duplicate-review', label: 'Deduplication' },
  { id: 'section-analysis-title-abstract', label: 'Title/Abstract Screening' },
  { id: 'section-analysis-full-text', label: 'Full-Text Screening' },
  { id: 'section-analysis-extraction-quality', label: 'Extraction & Quality' },
]

export function AnalysisPage() {
  const { projectId = '' } = useParams()
  useRegisterSectionItems(analysisSections)

  return (
    <main className="page">
      <StageEyebrow stage="completed" />
      <h1>Charts &amp; Analysis</h1>
      <p className="muted">
        Visual summaries of deduplication, screening, and extraction &amp; quality progress across
        this project.
      </p>
      <DuplicateReviewSection projectId={projectId} />
      <TitleAbstractSection projectId={projectId} />
      <FullTextSection projectId={projectId} />
      <ExtractionQualitySection projectId={projectId} />
    </main>
  )
}
