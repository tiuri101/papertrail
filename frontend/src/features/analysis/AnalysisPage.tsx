import { useParams } from 'react-router-dom'

import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateReviewSection } from './DuplicateReviewSection'
import { EvidenceMatrixSection } from './EvidenceMatrixSection'
import { ExtractionQualitySection } from './ExtractionQualitySection'
import { FullTextSection } from './FullTextSection'
import { ResearchQuestionAnalysisSection } from './ResearchQuestionAnalysisSection'
import { ReviewerAnalysisSection } from './ReviewerAnalysisSection'
import { TitleAbstractSection } from './TitleAbstractSection'

const analysisSections = [
  { id: 'section-analysis-duplicate-review', label: 'Deduplication' },
  { id: 'section-analysis-title-abstract', label: 'Title/Abstract Screening' },
  { id: 'section-analysis-full-text', label: 'Full-Text Screening' },
  { id: 'section-analysis-reviewer-analysis', label: 'Reviewer Analysis' },
  { id: 'section-analysis-extraction-quality', label: 'Extraction & Quality' },
  { id: 'section-analysis-evidence-matrix', label: 'Evidence Matrix' },
  { id: 'section-analysis-research-question', label: 'Research Question Analysis' },
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
      <ReviewerAnalysisSection projectId={projectId} />
      <ExtractionQualitySection projectId={projectId} />
      <EvidenceMatrixSection projectId={projectId} />
      <ResearchQuestionAnalysisSection projectId={projectId} />
    </main>
  )
}
