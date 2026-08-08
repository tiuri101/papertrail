import { Link, Navigate, Outlet, Route, Routes, useNavigate, useParams } from 'react-router-dom'

import { AppShell } from './AppShell'
import { DangerZonePanel } from '../features/administration/DangerZonePanel'
import { HighlightKeywordsPanel } from '../features/administration/HighlightKeywordsPanel'
import { MembersPanel } from '../features/administration/MembersPanel'
import { ProjectDetailsPanel } from '../features/administration/ProjectDetailsPanel'
import { ReviewerProgressPanel } from '../features/administration/ReviewerProgressPanel'
import { ScreeningAssignmentsPanel } from '../features/administration/ScreeningAssignmentsPanel'
import { ScreeningConfigPanel } from '../features/administration/ScreeningConfigPanel'
import { ResearchAgendaPanel } from '../features/administration/ResearchAgendaPanel'
import { AuditLogPage } from '../features/audit/AuditLogPage'
import { AccountSettingsPage } from '../features/auth/AccountSettingsPage'
import { AdminGate } from '../features/auth/AdminGate'
import { AuthGate } from '../features/auth/AuthGate'
import { LoginPage } from '../features/auth/LoginPage'
import { ConflictResolutionPage } from '../features/conflicts/ConflictResolutionPage'
import { DuplicateReviewPage } from '../features/duplicates/DuplicateReviewPage'
import { ExtractionPage } from '../features/extraction/ExtractionPage'
import { FormBuilderPage } from '../features/forms/FormBuilderPage'
import { FullTextPage } from '../features/fulltext/FullTextPage'
import { ImportPage } from '../features/imports/ImportPage'
import { JobsPage } from '../features/jobs/JobsPage'
import { LlmAssistancePanel } from '../features/llm/LlmAssistancePanel'
import { ProjectLifecyclePanel } from '../features/lifecycle/ProjectLifecyclePanel'
import { ProjectPage } from '../features/projects/ProjectPage'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { AddPublicationPage } from '../features/publications/AddPublicationPage'
import { PublicationsPage } from '../features/publications/PublicationsPage'
import { QualityPage } from '../features/quality/QualityPage'
import { ReportingPage } from '../features/reporting/ReportingPage'
import { FinalResultsPage } from '../features/results/FinalResultsPage'
import { MyDecisionsPage } from '../features/screening/MyDecisionsPage'
import { ScreeningPage } from '../features/screening/ScreeningPage'
import { UsersPage } from '../features/users/UsersPage'
import { useProjectManageState } from '../hooks/useCanManageProject'

function ProjectSectionLayout() {
  const { projectId = '' } = useParams()
  return (
    <>
      <div className="project-breadcrumb">
        <Link to={`/projects/${projectId}`}>← Back to project</Link>
      </div>
      <Outlet />
    </>
  )
}

function ProjectAdministrationPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  if (canManageLoading) {
    return <main className="page"><p>Loading…</p></main>
  }
  if (!canManage) {
    return (
      <main className="page">
        <p className="error" role="alert">
          Only the project owner or an administrator can access project administration.
        </p>
      </main>
    )
  }
  return (
    <main className="page">
      <ProjectDetailsPanel projectId={projectId} />
      <MembersPanel projectId={projectId} />
      <ScreeningConfigPanel projectId={projectId} />
      <ScreeningAssignmentsPanel projectId={projectId} />
      <ReviewerProgressPanel projectId={projectId} />
      <HighlightKeywordsPanel projectId={projectId} />
      <LlmAssistancePanel projectId={projectId} />
      <ProjectLifecyclePanel projectId={projectId} />
      <section className="card">
        <h2>Audit Log</h2>
        <p>Review a record of significant actions taken on this project.</p>
        <div className="toolbar">
          <button type="button" onClick={() => navigate(`/projects/${projectId}/audit`)}>
            View Audit Log
          </button>
        </div>
      </section>
      <DangerZonePanel projectId={projectId} />
    </main>
  )
}

function ResearchAgendaPage() {
  const { projectId = '' } = useParams()
  return (
    <main className="page">
      <h1>Research Agenda</h1>
      <ResearchAgendaPanel projectId={projectId} />
    </main>
  )
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/account" element={<AccountSettingsPage />} />
          <Route element={<AdminGate />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route element={<ProjectSectionLayout />}>
            <Route path="/projects/:projectId/admin" element={<ProjectAdministrationPage />} />
            <Route path="/projects/:projectId/research-agenda" element={<ResearchAgendaPage />} />
            <Route path="/projects/:projectId/audit" element={<AuditLogPage />} />
            <Route path="/projects/:projectId/imports" element={<ImportPage />} />
            <Route path="/projects/:projectId/jobs" element={<JobsPage />} />
            <Route path="/projects/:projectId/publications" element={<PublicationsPage />} />
            <Route path="/projects/:projectId/publications/add" element={<AddPublicationPage />} />
            <Route path="/projects/:projectId/duplicates" element={<DuplicateReviewPage />} />
            <Route path="/projects/:projectId/screening/:stage" element={<ScreeningPage />} />
            <Route path="/projects/:projectId/screening/:stage/my-decisions" element={<MyDecisionsPage />} />
            <Route path="/projects/:projectId/conflicts/:stage" element={<ConflictResolutionPage />} />
            <Route path="/projects/:projectId/full-text" element={<FullTextPage />} />
            <Route path="/projects/:projectId/forms" element={<FormBuilderPage />} />
            <Route path="/projects/:projectId/extraction" element={<ExtractionPage />} />
            <Route path="/projects/:projectId/quality" element={<QualityPage />} />
            <Route path="/projects/:projectId/results" element={<FinalResultsPage />} />
            <Route path="/projects/:projectId/reporting" element={<ReportingPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
