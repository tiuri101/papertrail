import { toolbarClass } from '../components/layoutStyles'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'

import { AppShell } from './AppShell'
import { DangerZonePanel } from '../features/administration/DangerZonePanel'
import { ExtractionSettingsPanel } from '../features/administration/ExtractionSettingsPanel'
import { HighlightKeywordsPanel } from '../features/administration/HighlightKeywordsPanel'
import { MembersPanel } from '../features/administration/MembersPanel'
import { ProjectDetailsPanel } from '../features/administration/ProjectDetailsPanel'
import { PromptSettingsPanel } from '../features/administration/PromptSettingsPanel'
import { QualitySettingsPanel } from '../features/administration/QualitySettingsPanel'
import { ReviewerProgressPanel } from '../features/administration/ReviewerProgressPanel'
import { ScreeningAssignmentsPanel } from '../features/administration/ScreeningAssignmentsPanel'
import { ScreeningConfigPanel } from '../features/administration/ScreeningConfigPanel'
import { ResearchAgendaPanel } from '../features/administration/ResearchAgendaPanel'
import { AuditLogPage } from '../features/audit/AuditLogPage'
import { Button } from '../components/Button'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { Page, pageStyles } from '../components/Page'
import { IconClock, IconSettings, IconSparkle, IconSwap, IconTrash } from '../components/icons'
import { InfoBox } from '../components/InfoBox'
import { useRegisterSectionItems } from '../components/sectionNavigation'
import { ScrollToTop } from '../components/ScrollToTop'
import type { SectionNavigationItem } from '../components/SectionNavigationLayout'
import { TabList, TabPanel } from '../components/Tabs'
import { AdminGate } from '../features/auth/AdminGate'
import { AuthGate } from '../features/auth/AuthGate'
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage'
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage'
import { LoginPage } from '../features/auth/LoginPage'
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage'
import { ConflictResolutionPage } from '../features/conflicts/ConflictResolutionPage'
import { DuplicateDecisionsPage } from '../features/duplicates/DuplicateDecisionsPage'
import { DuplicateQueuePage } from '../features/duplicates/DuplicateQueuePage'
import { ExtractionPage } from '../features/extraction/ExtractionPage'
import { MyExtractionsPage } from '../features/extraction/MyExtractionsPage'
import { ReconciliationPage } from '../features/extraction/ReconciliationPage'
import { ValidationReviewPage } from '../features/extraction/ValidationReviewPage'
import { FullTextPage } from '../features/fulltext/FullTextPage'
import { ImportPage } from '../features/imports/ImportPage'
import { InstanceSettingsPage } from '../features/instanceSettings/InstanceSettingsPage'
import { JobsPage } from '../features/jobs/JobsPage'
import { LlmAssistancePanel } from '../features/llm/LlmAssistancePanel'
import { MoveProjectBackPanel } from '../features/lifecycle/MoveProjectBackPanel'
import { ProjectLifecyclePanel } from '../features/lifecycle/ProjectLifecyclePanel'
import { ReopenProjectPanel } from '../features/lifecycle/ReopenProjectPanel'
import { ProjectPage } from '../features/projects/ProjectPage'
import { ProjectSectionLayout } from '../features/projects/ProjectSectionLayout'
import { ProjectSetupWizard } from '../features/projects/ProjectSetupWizard'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { AdministrationEyebrow, StageEyebrow } from '../features/projects/StageEyebrow'
import { AddPublicationPage } from '../features/publications/AddPublicationPage'
import { PublicationDetailPage } from '../features/publications/PublicationDetailPage'
import { PublicationsPage } from '../features/publications/PublicationsPage'
import { MyQualityPage } from '../features/quality/MyQualityPage'
import { QualityPage } from '../features/quality/QualityPage'
import { ReportingPage } from '../features/reporting/ReportingPage'
import { FinalResultsPage } from '../features/results/FinalResultsPage'
import { MyDecisionsPage } from '../features/screening/MyDecisionsPage'
import { TitleAbstractScreeningPage } from '../features/screening/TitleAbstractScreeningPage'
import { UsersPage } from '../features/users/UsersPage'
import { useProjectManageState } from '../hooks/useCanManageProject'

const AnalysisPage = lazy(async () => {
  const module = await import('../features/analysis/AnalysisPage')
  return { default: module.AnalysisPage }
})

const AccountSettingsPage = lazy(async () => {
  const module = await import('../features/auth/AccountSettingsPage')
  return { default: module.AccountSettingsPage }
})

const FormBuilderPage = lazy(async () => {
  const module = await import('../features/forms/FormBuilderPage')
  return { default: module.FormBuilderPage }
})

const HelpPage = lazy(async () => {
  const module = await import('../features/help/HelpPage')
  return { default: module.HelpPage }
})

const BookmarksPage = lazy(async () => {
  const module = await import('../features/bookmarks/BookmarksPage')
  return { default: module.BookmarksPage }
})

type AdminTabId = 'general' | 'workflow' | 'ai' | 'danger'

interface AdminTab {
  id: AdminTabId
  label: string
  icon: ReactNode
  sections: SectionNavigationItem[]
}

const adminTabs: AdminTab[] = [
  {
    id: 'general',
    label: 'General',
    icon: <IconSettings />,
    sections: [
      { id: 'section-project-details', label: 'Project Details' },
      { id: 'section-project-members', label: 'Project Members' },
      { id: 'section-screening-configuration', label: 'Screening Configuration' },
      { id: 'section-extraction-settings', label: 'Extraction Settings' },
      { id: 'section-quality-assessment-settings', label: 'Quality Assessment Settings' },
      { id: 'section-highlighted-keywords', label: 'Highlighted Keywords' },
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    icon: <IconSwap />,
    sections: [
      { id: 'section-screening-assignments', label: 'Screening Assignments' },
      { id: 'section-reviewer-progress', label: 'Reviewer Progress' },
      { id: 'section-workflow-integrity', label: 'Workflow Integrity' },
      { id: 'section-audit-log', label: 'Audit Log' },
    ],
  },
  {
    id: 'ai',
    label: 'AI Assistance',
    icon: <IconSparkle />,
    sections: [
      { id: 'section-llm-installation', label: 'LLM Installation' },
      { id: 'section-llm-capabilities', label: 'LLM Capabilities' },
      { id: 'section-llm-extraction-schema', label: 'LLM Extraction Schema' },
      { id: 'section-llm-processing-status', label: 'Processing Status' },
      { id: 'section-prompt-settings', label: 'AI Prompts' },
    ],
  },
  {
    id: 'danger',
    label: 'Danger Zone',
    icon: <IconTrash />,
    sections: [
      { id: 'section-reopen-project', label: 'Reopen at an Earlier Stage' },
      { id: 'section-reset-project', label: 'Reset Project' },
      { id: 'section-delete-project', label: 'Delete Project' },
    ],
  },
]

const researchAgendaSections = [
  { id: 'section-research-questions', label: 'Research Questions' },
  { id: 'section-screening-criteria', label: 'Inclusion / Exclusion Criteria' },
]

function ProjectAdministrationPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  const [activeTab, setActiveTab] = useState<AdminTabId>('general')
  const currentTab = adminTabs.find((tab) => tab.id === activeTab) ?? adminTabs[0]
  useRegisterSectionItems(currentTab.sections)
  if (canManageLoading) {
    return <main className={pageStyles}><p>Loading…</p></main>
  }
  if (!canManage) {
    return (
      <main className={pageStyles}>
        <p className="text-danger" role="alert">
          Only the project owner or an administrator can access project administration.
        </p>
      </main>
    )
  }
  return (
    <main className={pageStyles}>
      <AdministrationEyebrow />
      <h1>Project Administration</h1>
      <p className="text-text-muted">
        Configure this project's details, membership, workflow rules, and AI assistance.
      </p>
      <TabList
        idPrefix="admin"
        label="Project administration sections"
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as AdminTabId)}
        className="mb-6"
        items={adminTabs.map((tab) => ({
          id: tab.id,
          label: <>{tab.icon}{tab.label}</>,
          danger: tab.id === 'danger',
        }))}
      />
      <TabPanel idPrefix="admin" id={activeTab}>
        {activeTab === 'general' ? (
          <>
            <ProjectDetailsPanel projectId={projectId} />
            <MembersPanel projectId={projectId} />
            <ScreeningConfigPanel projectId={projectId} />
            <ExtractionSettingsPanel projectId={projectId} />
            <QualitySettingsPanel projectId={projectId} />
            <HighlightKeywordsPanel projectId={projectId} />
          </>
        ) : null}
        {activeTab === 'workflow' ? (
          <>
            <ScreeningAssignmentsPanel projectId={projectId} />
            <ReviewerProgressPanel projectId={projectId} />
            <ProjectLifecyclePanel projectId={projectId} />
            <CollapsibleSection id="section-audit-log" title="Audit Log" icon={<IconClock />}>
              <InfoBox icon={<IconClock />}>
                <p>
                  A chronological record of significant actions taken on this project, such as
                  membership changes, configuration updates, and stage transitions.
                </p>
              </InfoBox>
              <div className={toolbarClass + ' mb-0'}>
                <Button type="button" onClick={() => navigate(`/projects/${projectId}/audit`)}>
                  View Audit Log
                </Button>
              </div>
            </CollapsibleSection>
          </>
        ) : null}
        {activeTab === 'ai' ? (
          <>
            <LlmAssistancePanel projectId={projectId} />
            <PromptSettingsPanel projectId={projectId} />
          </>
        ) : null}
        {activeTab === 'danger' ? (
          <>
            <MoveProjectBackPanel projectId={projectId} />
            <ReopenProjectPanel projectId={projectId} />
            <DangerZonePanel projectId={projectId} />
          </>
        ) : null}
      </TabPanel>
    </main>
  )
}

function ResearchAgendaPage() {
  const { projectId = '' } = useParams()
  useRegisterSectionItems(researchAgendaSections)
  return (
    <Page>
      <StageEyebrow stage="draft" />
      <h1>Research Agenda</h1>
      <p className="text-text-muted">
        Define this project's research questions and the inclusion/exclusion criteria reviewers
        will screen against.
      </p>
      <ResearchAgendaPanel projectId={projectId} />
    </Page>
  )
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<AuthGate />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route
            path="/account"
            element={(
              <Suspense fallback={<main className={pageStyles}><p>Loading account settings…</p></main>}>
                <AccountSettingsPage />
              </Suspense>
            )}
          />
          <Route
            path="/help"
            element={(
              <Suspense fallback={<main className={pageStyles}><p>Loading help…</p></main>}>
                <HelpPage />
              </Suspense>
            )}
          />
          <Route
            path="/bookmarks"
            element={(
              <Suspense fallback={<main className={pageStyles}><p>Loading bookmarks…</p></main>}>
                <BookmarksPage />
              </Suspense>
            )}
          />
          <Route element={<AdminGate />}>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/instance-settings" element={<InstanceSettingsPage />} />
          </Route>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<ProjectSetupWizard />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route element={<ProjectSectionLayout />}>
            <Route path="/projects/:projectId/setup" element={<ProjectSetupWizard />} />
            <Route path="/projects/:projectId/admin" element={<ProjectAdministrationPage />} />
            <Route path="/projects/:projectId/research-agenda" element={<ResearchAgendaPage />} />
            <Route path="/projects/:projectId/audit" element={<AuditLogPage />} />
            <Route path="/projects/:projectId/imports" element={<ImportPage />} />
            <Route path="/projects/:projectId/jobs" element={<JobsPage />} />
            <Route path="/projects/:projectId/publications" element={<PublicationsPage />} />
            <Route path="/projects/:projectId/publications/add" element={<AddPublicationPage />} />
            <Route path="/projects/:projectId/publications/:publicationId" element={<PublicationDetailPage />} />
            <Route path="/projects/:projectId/duplicates" element={<DuplicateQueuePage />} />
            <Route path="/projects/:projectId/duplicates/decisions" element={<DuplicateDecisionsPage />} />
            <Route path="/projects/:projectId/screening/title_abstract" element={<TitleAbstractScreeningPage />} />
            <Route path="/projects/:projectId/screening/:stage/my-decisions" element={<MyDecisionsPage />} />
            <Route path="/projects/:projectId/conflicts/:stage" element={<ConflictResolutionPage />} />
            <Route path="/projects/:projectId/full-text" element={<FullTextPage />} />
            <Route
              path="/projects/:projectId/forms"
              element={(
                <Suspense fallback={<main className={pageStyles}><p>Loading forms…</p></main>}>
                  <FormBuilderPage />
                </Suspense>
              )}
            />
            <Route path="/projects/:projectId/extraction" element={<ExtractionPage />} />
            <Route path="/projects/:projectId/extraction/review/:itemId" element={<ExtractionPage />} />
            <Route path="/projects/:projectId/extraction/mine" element={<MyExtractionsPage />} />
            <Route path="/projects/:projectId/extraction/validation" element={<ValidationReviewPage />} />
            <Route path="/projects/:projectId/extraction/reconciliation" element={<ReconciliationPage />} />
            <Route path="/projects/:projectId/quality" element={<QualityPage />} />
            <Route path="/projects/:projectId/quality/review/:itemId" element={<QualityPage />} />
            <Route path="/projects/:projectId/quality/mine" element={<MyQualityPage />} />
            <Route path="/projects/:projectId/results" element={<FinalResultsPage />} />
            <Route
              path="/projects/:projectId/analysis"
              element={(
                <Suspense fallback={<main className={pageStyles}><p>Loading analysis…</p></main>}>
                  <AnalysisPage />
                </Suspense>
              )}
            />
            <Route path="/projects/:projectId/reporting" element={<ReportingPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
      </Routes>
    </>
  )
}
