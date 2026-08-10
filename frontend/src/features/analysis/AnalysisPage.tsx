import { useParams } from 'react-router-dom'

import { useRegisterSectionItems } from '../../components/sectionNavigation'
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
      <p className="eyebrow">Review outputs</p>
      <h1>Charts &amp; Analysis</h1>
      <DuplicateReviewSection projectId={projectId} />
      <TitleAbstractSection projectId={projectId} />
      <FullTextSection projectId={projectId} />
      <ExtractionQualitySection projectId={projectId} />
    </main>
  )
}
