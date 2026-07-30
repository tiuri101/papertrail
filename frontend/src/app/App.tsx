import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { AppShell } from './AppShell'
import { ProjectDashboard } from '../features/administration/ProjectDashboard'
import { AdminGate } from '../features/auth/AdminGate'
import { AuthGate } from '../features/auth/AuthGate'
import { LoginPage } from '../features/auth/LoginPage'
import { ConflictResolutionPage } from '../features/conflicts/ConflictResolutionPage'
import { DuplicateReviewPage } from '../features/duplicates/DuplicateReviewPage'
import { ExtractionPage } from '../features/extraction/ExtractionPage'
import { FormBuilderPage } from '../features/forms/FormBuilderPage'
import { FullTextPage } from '../features/fulltext/FullTextPage'
import { ImportPage } from '../features/imports/ImportPage'
import { ProjectLifecyclePanel } from '../features/lifecycle/ProjectLifecyclePanel'
import { ProjectPage } from '../features/projects/ProjectPage'
import { ProjectsPage } from '../features/projects/ProjectsPage'
import { PublicationsPage } from '../features/publications/PublicationsPage'
import { QualityPage } from '../features/quality/QualityPage'
import { ReportingPage } from '../features/reporting/ReportingPage'
import { ScreeningPage } from '../features/screening/ScreeningPage'
import { UsersPage } from '../features/users/UsersPage'

function HomePage() {
  return <main className="page"><h1>Papertrail</h1><p>Academic literature review management.</p></main>
}

function ProjectAdministrationPage() {
  const { projectId = '' } = useParams()
  return <main className="page"><ProjectDashboard projectId={projectId} /><ProjectLifecyclePanel projectId={projectId} /></main>
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route element={<AdminGate />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/projects/:projectId/admin" element={<ProjectAdministrationPage />} />
          <Route path="/projects/:projectId/imports" element={<ImportPage />} />
          <Route path="/projects/:projectId/publications" element={<PublicationsPage />} />
          <Route path="/projects/:projectId/duplicates" element={<DuplicateReviewPage />} />
          <Route path="/projects/:projectId/screening/:stage" element={<ScreeningPage />} />
          <Route path="/projects/:projectId/conflicts/:stage" element={<ConflictResolutionPage />} />
          <Route path="/projects/:projectId/full-text" element={<FullTextPage />} />
          <Route path="/projects/:projectId/forms" element={<FormBuilderPage />} />
          <Route path="/projects/:projectId/extraction" element={<ExtractionPage />} />
          <Route path="/projects/:projectId/quality" element={<QualityPage />} />
          <Route path="/projects/:projectId/reporting" element={<ReportingPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
