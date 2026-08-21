import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconChart, IconCheckCircle, IconCopy, IconFile, IconLightbulb } from '../../components/icons'
import { Page } from '../../components/Page'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import type { SectionNavigationItem } from '../../components/SectionNavigationLayout'
import { TabList, TabPanel } from '../../components/Tabs'
import { StageEyebrow, type ProjectStageValue } from '../projects/StageEyebrow'
import { DuplicateReviewSection } from './DuplicateReviewSection'
import { EvidenceMatrixSection } from './EvidenceMatrixSection'
import { ExtractionQualitySection } from './ExtractionQualitySection'
import { FullTextSection } from './FullTextSection'
import { GeneralAnalysisSection } from './GeneralAnalysisSection'
import { ResearchQuestionAnalysisSection } from './ResearchQuestionAnalysisSection'
import { ReviewerAnalysisSection } from './ReviewerAnalysisSection'
import { TitleAbstractSection } from './TitleAbstractSection'

type AnalysisTabId = 'general' | 'deduplication' | 'screening' | 'extraction' | 'research_questions'

interface AnalysisTab {
  id: AnalysisTabId
  label: string
  icon: ReactNode
  sections: SectionNavigationItem[]
  availableFromIndex: number
  unavailableTitle?: string
}

interface ProjectAnalysisContext {
  stage: ProjectStageValue
}

const PROJECT_STAGE_INDEX: Record<ProjectStageValue, number> = {
  draft: 0,
  duplicate_review: 1,
  title_abstract_screening: 2,
  full_text_screening: 3,
  extraction_quality: 4,
  completed: 5,
}

const analysisTabs: AnalysisTab[] = [
  {
    id: 'general',
    label: 'General',
    icon: <IconChart />,
    sections: [
      { id: 'section-analysis-general', label: 'General Overview' },
    ],
    availableFromIndex: 0,
  },
  {
    id: 'deduplication',
    label: 'Deduplication',
    icon: <IconCopy />,
    sections: [
      { id: 'section-analysis-duplicate-review', label: 'Deduplication' },
    ],
    availableFromIndex: 2,
    unavailableTitle: 'Available after deduplication is complete.',
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
    availableFromIndex: 3,
    unavailableTitle: 'Available after title/abstract screening is complete.',
  },
  {
    id: 'extraction',
    label: 'Extraction & Quality',
    icon: <IconFile />,
    sections: [
      { id: 'section-analysis-extraction-quality', label: 'Extraction & Quality' },
      { id: 'section-analysis-evidence-matrix', label: 'Evidence Matrix' },
    ],
    availableFromIndex: 5,
    unavailableTitle: 'Available after extraction and quality assessment are complete.',
  },
  {
    id: 'research_questions',
    label: 'Research Questions',
    icon: <IconLightbulb />,
    sections: [
      { id: 'section-analysis-research-question', label: 'Research Question Analysis' },
    ],
    availableFromIndex: 5,
    unavailableTitle: 'Available after extraction and quality assessment are complete.',
  },
]

export function AnalysisPage() {
  const { projectId = '' } = useParams()
  const [activeTab, setActiveTab] = useState<AnalysisTabId>('general')
  const [reviewerAnalysisVisible, setReviewerAnalysisVisible] = useState(true)
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAnalysisContext>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const currentStageIndex = project.data ? PROJECT_STAGE_INDEX[project.data.stage] : 0
  const availability = {
    duplicateReview: currentStageIndex >= 2,
    titleAbstract: currentStageIndex >= 3,
    fullText: currentStageIndex >= 4,
    extraction: currentStageIndex >= 5,
  }
  const currentTab = analysisTabs.find((tab) => tab.id === activeTab) ?? analysisTabs[0]
  const currentSections = useMemo(() => (
    activeTab === 'screening'
      ? currentTab.sections.filter((section) => (
        (section.id !== 'section-analysis-full-text' || availability.fullText)
        && (section.id !== 'section-analysis-reviewer-analysis' || reviewerAnalysisVisible)
      ))
      : currentTab.sections
  ), [activeTab, availability.fullText, currentTab, reviewerAnalysisVisible])
  useRegisterSectionItems(currentSections)

  if (project.isLoading) return <Page><p>Loading analysis...</p></Page>
  if (!project.data) {
    return <Page><p className="text-danger" role="alert">Project could not be loaded.</p></Page>
  }

  return (
    <Page>
      <StageEyebrow stage={project.data.stage} />
      <h1>Charts &amp; Analysis</h1>
      <p className="text-text-muted">
        Visual summaries of validated results from each completed review stage.
      </p>
      <TabList
        idPrefix="analysis"
        label="Charts & Analysis sections"
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as AnalysisTabId)}
        className="mb-6"
        items={analysisTabs.map((tab) => ({
          id: tab.id,
          label: <>{tab.icon}{tab.label}</>,
          disabled: currentStageIndex < tab.availableFromIndex,
          title: currentStageIndex >= tab.availableFromIndex ? undefined : tab.unavailableTitle,
        }))}
      />
      <TabPanel idPrefix="analysis" id={activeTab}>
        {activeTab === 'general' ? (
          <GeneralAnalysisSection projectId={projectId} availability={availability} />
        ) : null}
        {activeTab === 'deduplication' ? (
          <DuplicateReviewSection projectId={projectId} />
        ) : null}
        {activeTab === 'screening' ? (
          <>
            <TitleAbstractSection projectId={projectId} />
            {availability.fullText ? <FullTextSection projectId={projectId} /> : null}
            <ReviewerAnalysisSection
              projectId={projectId}
              stages={availability.fullText ? ['title_abstract', 'full_text'] : ['title_abstract']}
              onVisibilityChange={setReviewerAnalysisVisible}
            />
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
      </TabPanel>
    </Page>
  )
}
