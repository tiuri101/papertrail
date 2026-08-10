import type { CSSProperties } from 'react'

import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconArrowRight, IconFolder, IconInfo, IconLightbulb, IconUsers } from '../../components/icons'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { STAGES } from '../projects/StageProgress'

const helpSections = [
  { id: 'section-help-overview', label: 'Overview' },
  { id: 'section-help-stages', label: 'Review Stages' },
  { id: 'section-help-reviewer', label: 'Reviewer' },
  { id: 'section-help-owner', label: 'Project Owner' },
  { id: 'section-help-good-to-know', label: 'Good to Know' },
]

const stageDescriptions: Record<string, string> = {
  draft: 'Set up the project: add reviewers, define research questions and criteria, configure screening settings, and import search results.',
  duplicate_review: 'Resolve every suggested duplicate: mark it as not a duplicate, or merge it and choose which record stays canonical.',
  title_abstract_screening: 'Each reviewer checks every publication against the inclusion/exclusion criteria and decides include, exclude, uncertain, or duplicate.',
  full_text_screening: 'Retrieve and upload full-text PDFs, then make the final eligibility decision for each publication that passed title/abstract screening.',
  extraction_quality: 'Extract structured data from each included publication and, when enabled, assess its quality or risk of bias.',
  completed: 'Review integrity warnings, generate PRISMA, Excel, and BibTeX exports, or reopen an earlier stage if corrections are still needed.',
}

function StageTimeline() {
  return (
    <ol className="help-stage-timeline" aria-label="Review stages">
      {STAGES.map((stage, index) => (
        <li
          className="help-stage-timeline__item"
          key={stage.value}
          style={{ '--stage-color': stage.color } as CSSProperties}
        >
          <span className="help-stage-timeline__number" aria-hidden="true">{index + 1}</span>
          <div className="help-stage-timeline__body">
            <h3>{stage.label}</h3>
            <p>{stageDescriptions[stage.value]}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

type StageId = (typeof STAGES)[number]['value']

interface StageResponsibilities {
  id: StageId
  name: string
  owner: string[]
  reviewer: string[]
}

const stages: StageResponsibilities[] = [
  {
    id: 'draft',
    name: 'Draft',
    owner: [
      'Create the project, add reviewers, and set each one’s eligibility for screening, extraction, quality assessment, and adjudication.',
      'Configure screening settings: how many reviewers are required per stage, and how disagreements or uncertain decisions get resolved.',
    ],
    reviewer: [
      'Help define the research questions and inclusion/exclusion criteria. Any project member can edit these.',
      'Document each database search (database, search string, date, filters) and upload its export file. You can select multiple export files and/or ZIP archives of PDFs at once.',
    ],
  },
  {
    id: 'duplicate_review',
    name: 'Duplicate Review',
    owner: [
      'Mark the project ready to enter duplicate review once imports and metadata are settled.',
      'Resolve duplicate candidates like any member, and can reverse a completed merge.',
    ],
    reviewer: [
      'Resolve each suggested duplicate: mark it as not a duplicate, or merge it and choose which record stays canonical.',
    ],
  },
  {
    id: 'title_abstract_screening',
    name: 'Title/Abstract Screening',
    owner: [
      'Monitor reviewer progress and adjust screening assignments as needed.',
      'Resolve screening conflicts and uncertain decisions according to the configured resolution method.',
    ],
    reviewer: [
      'Work the active screening queue: inspect each publication, check it against every inclusion/exclusion criterion, and decide include, exclude, uncertain, or duplicate. Notes are optional and drafts autosave.',
      'In independent screening, other reviewers’ answers stay hidden until all required decisions are submitted. A submitted decision can still be revised, which reopens any existing consensus.',
    ],
  },
  {
    id: 'full_text_screening',
    name: 'Full-Text Retrieval & Screening',
    owner: [
      'Track manual full-text retrieval and, together with full-text reviewers and administrators, upload, replace, or remove PDFs.',
      'Resolve full-text screening conflicts.',
    ],
    reviewer: [
      'Retrieve the full text using the DOI/publisher link Papertrail provides, then upload the PDF directly from the screening page. Papertrail never downloads publisher content automatically.',
      'Save the retrieval status first, then complete the eligibility decision. Page-aware LLM assistance, when enabled, stays visible during review and points to verified passages and physical PDF pages.',
    ],
  },
  {
    id: 'extraction_quality',
    name: 'Extraction & Quality Assessment',
    owner: [
      'Configure the project’s extraction and quality-assessment forms.',
      'Reopen a reviewer’s submitted extraction or quality assessment if it needs correction, and review LLM extraction-validation results when that’s enabled.',
    ],
    reviewer: [
      'Complete every required field for each publication you’re assigned to extract or, when enabled, quality-assess. Submitted work can be revised.',
      'Optional LLM suggestions appear beside each field with an explicit/inferred/ambiguous/missing status and page evidence. Apply a suggestion explicitly or enter your own data.',
    ],
  },
  {
    id: 'completed',
    name: 'Completed',
    owner: [
      'Review integrity warnings, then generate the PRISMA flow diagram, Excel workbook, and BibTeX export.',
      'Reopen the project at an earlier stage if corrections are needed later; downstream data is retained but excluded from active counts.',
    ],
    reviewer: [
      'Browse the sortable, paginated table of every finally included publication with its extraction answers and, when enabled, quality-assessment answers and score.',
    ],
  },
]

function StageList({ role }: { role: 'owner' | 'reviewer' }) {
  return (
    <ol
      className="help-stage-timeline help-stage-timeline--responsibilities"
      aria-label={role === 'reviewer' ? 'Reviewer responsibilities by stage' : 'Project owner responsibilities by stage'}
    >
      {stages.map((stage, index) => {
        const color = STAGES.find((item) => item.value === stage.id)?.color

        return (
          <li
            className="help-stage-timeline__item"
            key={stage.id}
            style={{ '--stage-color': color } as CSSProperties}
          >
            <span className="help-stage-timeline__number" aria-hidden="true">{index + 1}</span>
            <div className="help-stage-timeline__body">
              <h3>{stage.name}</h3>
              <ul>
                {stage[role].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function HelpPage() {
  return (
    <SectionNavigationLayout items={helpSections} label="On this page">
      <main className="page">
        <h1>Help</h1>
        <CollapsibleSection id="section-help-overview" title="What Papertrail Does" icon={<IconInfo />}>
          <p>
            Papertrail is a tool for running a systematic literature review as a
            team. It takes a project from imported search results through deduplication,
            multi-reviewer screening, full-text retrieval, and configurable extraction and
            quality-assessment forms, and produces PRISMA flow outputs, an Excel workbook,
            and a BibTeX export that you can then analyze for your review.
          </p>
          <p>
            Every project moves through six shared stages: <strong>draft</strong>,{' '}
            <strong>duplicate review</strong>, <strong>title/abstract screening</strong>,{' '}
            <strong>full-text retrieval and screening</strong>,{' '}
            <strong>extraction and quality assessment</strong>, and{' '}
            <strong>completed</strong>. Papertrail advances a project automatically once the
            completion rules for its current stage are satisfied.
          </p>
          <p>
            Every screening, extraction, and lifecycle action is written to an immutable audit
            trail. An optional local LLM can suggest — but never decide — screening and
            extraction answers. Reviewer-entered data always remains authoritative.
          </p>
        </CollapsibleSection>
        <CollapsibleSection id="section-help-stages" title="The Review Stages" icon={<IconArrowRight />}>
          <StageTimeline />
        </CollapsibleSection>
        <CollapsibleSection id="section-help-reviewer" title="As a Reviewer" icon={<IconUsers />}>
          <p>
            A reviewer is any member added to a project. You only see the projects you belong to,
            and only the actions within them you’re actually eligible for.
          </p>
          <StageList role="reviewer" />
        </CollapsibleSection>
        <CollapsibleSection id="section-help-owner" title="As a Project Owner" icon={<IconFolder />}>
          <p>
            The project owner is whoever created the project. Alongside the stage-by-stage
            responsibilities below, an owner can manage members and their eligibility, project
            details and highlighted keywords, LLM assistance settings, the audit log, and
            lifecycle actions such as resetting or deleting the project — all scoped to that
            one project. An installation administrator has the same rights on every project.
          </p>
          <StageList role="owner" />
        </CollapsibleSection>
        <CollapsibleSection id="section-help-good-to-know" title="Good to Know" icon={<IconLightbulb />}>
          <ul>
            <li>
              Papertrail never downloads or scrapes publisher PDFs automatically. Only
              upload files you are authorized to access and store.
            </li>
            <li>
              LLM assistance is advisory-only and must be enabled per project by an
              administrator. It never overrides a reviewer’s decision.
            </li>
            <li>
              A screening item you’ve opened stays reserved to you for up to one day unless
              you release it, so it doesn’t block other reviewers indefinitely.
            </li>
            <li>
              Replacing a PDF creates a new version and keeps the previous file in a collapsible
              history. Removing one preserves history and never changes an existing screening
              decision.
            </li>
            <li>
              You can update or clear your notification email address any time under{' '}
              <strong>Account Settings</strong>.
            </li>
          </ul>
        </CollapsibleSection>
      </main>
    </SectionNavigationLayout>
  )
}
