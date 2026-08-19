import { useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

import { IconCheckCircle, IconCopy, IconFile, IconLightbulb } from '../../components/icons'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import type { SectionNavigationItem } from '../../components/SectionNavigationLayout'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateReviewSection } from './DuplicateReviewSection'
import { EvidenceMatrixSection } from './EvidenceMatrixSection'
import { ExtractionQualitySection } from './ExtractionQualitySection'
import { FullTextSection } from './FullTextSection'
import { ResearchQuestionAnalysisSection } from './ResearchQuestionAnalysisSection'
import { ReviewerAnalysisSection } from './ReviewerAnalysisSection'
import { TitleAbstractSection } from './TitleAbstractSection'

type AnalysisTabId = 'deduplication' | 'screening' | 'extraction' | 'research_questions'

interface AnalysisTab {
  id: AnalysisTabId
  label: string
  icon: ReactNode
  sections: SectionNavigationItem[]
}

const analysisTabs: AnalysisTab[] = [
  {
    id: 'deduplication',
    label: 'Deduplication',
    icon: <IconCopy />,
    sections: [
      { id: 'section-analysis-duplicate-review', label: 'Deduplication' },
    ],
  },
  {
    id: 'screening',
    label: 'Screening',
    icon: <IconCheckCircle />,
    sections: [
      { id: 'section-analysis-title-abstract', label: 'Title/Abstract Screening' },
      { id: 'section-analysis-full-text', label: 'Full-Text Screening' },
      { id: 'section-analysis-reviewer-analysis', label: 'Reviewer Analysis' },
    ],
  },
  {
    id: 'extraction',
    label: 'Extraction & Quality',
    icon: <IconFile />,
    sections: [
      { id: 'section-analysis-extraction-quality', label: 'Extraction & Quality' },
      { id: 'section-analysis-evidence-matrix', label: 'Evidence Matrix' },
    ],
  },
  {
    id: 'research_questions',
    label: 'Research Questions',
    icon: <IconLightbulb />,
    sections: [
      { id: 'section-analysis-research-question', label: 'Research Question Analysis' },
    ],
  },
]

export function AnalysisPage() {
  const { projectId = '' } = useParams()
  const [activeTab, setActiveTab] = useState<AnalysisTabId>('deduplication')
  const currentTab = analysisTabs.find((tab) => tab.id === activeTab) ?? analysisTabs[0]
  useRegisterSectionItems(currentTab.sections)

  return (
    <main className="page">
      <StageEyebrow stage="completed" />
      <h1>Charts &amp; Analysis</h1>
      <p className="muted">
        Visual summaries of deduplication, screening, and extraction &amp; quality progress across
        this project.
      </p>
      <div className="page-tabs" role="tablist" aria-label="Charts & Analysis sections">
        {analysisTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`analysis-tab-${tab.id}`}
            aria-selected={tab.id === activeTab}
            aria-controls={`analysis-tabpanel-${tab.id}`}
            className={`page-tab${tab.id === activeTab ? ' page-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`analysis-tabpanel-${activeTab}`}
        className="page-tabpanel"
        role="tabpanel"
        aria-labelledby={`analysis-tab-${activeTab}`}
      >
        {activeTab === 'deduplication' ? (
          <DuplicateReviewSection projectId={projectId} />
        ) : null}
        {activeTab === 'screening' ? (
          <>
            <TitleAbstractSection projectId={projectId} />
            <FullTextSection projectId={projectId} />
            <ReviewerAnalysisSection projectId={projectId} />
          </>
        ) : null}
        {activeTab === 'extraction' ? (
          <>
            <ExtractionQualitySection projectId={projectId} />
            <EvidenceMatrixSection projectId={projectId} />
          </>
        ) : null}
        {activeTab === 'research_questions' ? (
          <ResearchQuestionAnalysisSection projectId={projectId} />
        ) : null}
      </div>
    </main>
  )
}
