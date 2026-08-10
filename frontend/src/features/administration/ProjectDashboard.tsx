import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { api } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import {
  IconChart,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconFolder,
  IconHelpCircle,
  IconInfo,
  IconXCircle,
} from '../../components/icons'

function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

type MetricGroup = 'funnel' | 'attention'

interface MetricMeta {
  label: string
  icon: ReactNode
  group: MetricGroup
  danger?: boolean
}

const METRIC_META: Record<string, MetricMeta> = {
  totalPapers: { label: 'Total papers', icon: <IconFolder />, group: 'funnel' },
  papersAfterDuplicateReview: { label: 'Papers after duplicate review', icon: <IconCopy />, group: 'funnel' },
  papersAfterTitleAbstractScreening: { label: 'Papers after title abstract screening', icon: <IconCheckCircle />, group: 'funnel' },
  papersAfterFullTextScreening: { label: 'Papers after full text screening', icon: <IconCheckCircle />, group: 'funnel' },
  unresolvedDuplicates: { label: 'Unresolved duplicates', icon: <IconCopy />, group: 'attention' },
  uncertainDecisions: { label: 'Uncertain decisions', icon: <IconHelpCircle />, group: 'attention' },
  reportsNotRetrieved: { label: 'Reports not retrieved', icon: <IconXCircle />, group: 'attention' },
  extractionRemaining: { label: 'Extraction remaining', icon: <IconClock />, group: 'attention' },
  qualityRemaining: { label: 'Quality remaining', icon: <IconClock />, group: 'attention' },
  failedJobs: { label: 'Failed jobs', icon: <IconXCircle />, group: 'attention', danger: true },
}

function metaFor(key: string): MetricMeta {
  return METRIC_META[key] ?? { label: humanizeKey(key), icon: <IconInfo />, group: 'attention' }
}

function MetricTable({ entries }: { entries: [string, number | string][] }) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Metric</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, value]) => {
          const meta = metaFor(key)
          const flagged = meta.group === 'attention' && !(typeof value === 'number' && value === 0)
          return (
            <tr key={key}>
              <th scope="row">
                <span className="project-status__row-icon" aria-hidden="true">{meta.icon}</span>
                {meta.label}
              </th>
              <td>
                {flagged ? (
                  <span className={`status-badge ${meta.danger ? 'status-badge--danger' : 'status-badge--warning'}`}>
                    {value}
                  </span>
                ) : (
                  <span className="project-status__value">{value}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function ProjectDashboard({ projectId }: { projectId: string }) {
  const dashboard = useQuery({
    queryKey: ['project-dashboard', projectId],
    queryFn: () => api<Record<string, number | string>>(`/projects/${projectId}/dashboard`),
  })

  const entries = dashboard.data
    ? Object.entries(dashboard.data).filter(([key]) => key !== 'stage')
    : []
  const funnelEntries = entries.filter(([key]) => metaFor(key).group === 'funnel')
  const attentionEntries = entries.filter(([key]) => metaFor(key).group === 'attention')

  return (
    <CollapsibleSection id="section-project-status" title="Project Status" icon={<IconChart />}>
      {dashboard.isLoading ? <p>Loading project status…</p> : null}
      {dashboard.isError ? <p>Project status could not be loaded.</p> : null}
      {dashboard.data ? (
        <div className="project-status">
          <InfoBox icon={<IconChart />}>
            <span className="eyebrow">Live snapshot</span>
            <h3>How the review is progressing</h3>
            <p>
              Publications move through duplicate review and screening on the left. Anything
              waiting on a decision, retrieval, or a failed background job shows up on the right.
            </p>
          </InfoBox>
          <div className="project-status__groups">
            {funnelEntries.length ? (
              <section className="project-status__group" aria-label="Publication funnel">
                <h4>Publication Funnel</h4>
                <MetricTable entries={funnelEntries} />
              </section>
            ) : null}
            {attentionEntries.length ? (
              <section className="project-status__group project-status__group--attention" aria-label="Needs attention">
                <h4>Needs Attention</h4>
                <MetricTable entries={attentionEntries} />
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </CollapsibleSection>
  )
}
