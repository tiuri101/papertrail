import { type CSSProperties, type ReactNode, useState } from 'react'

import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { Page } from '../../components/Page'
import {
  IconArrowRight,
  IconCheckCircle,
  IconClock,
  IconDownload,
  IconFolder,
  IconGear,
  IconInfo,
  IconKeyboard,
  IconLightbulb,
  IconPerson,
  IconPlus,
  IconRestart,
  IconSparkle,
  IconSwap,
  IconTrash,
  IconUpload,
  IconUsers,
} from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import { SectionNavigationLayout, type SectionNavigationItem } from '../../components/SectionNavigationLayout'
import { TabList, TabPanel } from '../../components/Tabs'
import { STAGES } from '../projects/StageProgress'

type HelpTabId = 'getting-started' | 'roles' | 'ai-automation' | 'browser-extension' | 'good-to-know'

interface HelpTab {
  id: HelpTabId
  label: string
  icon: ReactNode
  sections: SectionNavigationItem[]
}

const helpTabs: HelpTab[] = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    icon: <IconInfo />,
    sections: [
      { id: 'section-help-overview', label: 'Overview' },
      { id: 'section-help-stages', label: 'Review Stages' },
    ],
  },
  {
    id: 'roles',
    label: 'Roles & Responsibilities',
    icon: <IconUsers />,
    sections: [
      { id: 'section-help-reviewer', label: 'Reviewer' },
      { id: 'section-help-owner', label: 'Project Owner' },
    ],
  },
  {
    id: 'ai-automation',
    label: 'AI & Automation',
    icon: <IconSparkle />,
    sections: [
      { id: 'section-help-llm', label: 'LLM Assistance' },
    ],
  },
  {
    id: 'browser-extension',
    label: 'Browser Extension',
    icon: <IconDownload />,
    sections: [
      { id: 'section-help-extension-overview', label: 'What It Does' },
      { id: 'section-help-extension-install', label: 'Install in Chrome' },
      { id: 'section-help-extension-use', label: 'Pair & Use' },
    ],
  },
  {
    id: 'good-to-know',
    label: 'Good to Know',
    icon: <IconLightbulb />,
    sections: [
      { id: 'section-help-good-to-know', label: 'Good to Know' },
    ],
  },
]

const stageDescriptions: Record<string, string> = {
  draft: 'Set up the project: add reviewers, define research questions and criteria, configure screening settings, and import search results.',
  duplicate_review: 'Resolve every suggested duplicate: mark it as not a duplicate, or merge it and choose which record stays canonical. Papertrail checks each record’s links and asks Crossref / Semantic Scholar which record to keep — shown as a non-binding suggestion, with provider-confirmed same-work pairs merged automatically. Records imported later are checked the same way before they reach screening, and a merge always keeps the record that already has screening decisions.',
  title_abstract_screening: 'Each reviewer checks every publication against the inclusion/exclusion criteria and decides include, exclude, uncertain, or duplicate.',
  full_text_screening: 'Retrieve and upload full-text PDFs, then make the final eligibility decision for each publication that passed title/abstract screening.',
  extraction_quality: 'Extract structured data from each included publication and, when enabled, assess its quality or risk of bias.',
  completed: 'Review integrity warnings, generate PRISMA, Excel, Parquet, JSON, CSV, and BibTeX exports, or reopen an earlier stage if corrections are still needed.',
}

const llmStageDescriptions: Record<string, string> = {
  draft: 'No review suggestions are generated. The project owner can enable LLM support for every stage independently, prepare the extraction schema, and add project-specific prompt instructions.',
  duplicate_review: 'Duplicate review is entirely human-led. The LLM does not identify, merge, or dismiss duplicate records.',
  title_abstract_screening: 'The LLM can compare a publication\'s title and abstract with the project criteria. Its include, exclude, or uncertain suggestion is hidden until you submit your own decision, so it cannot influence an independent first assessment.',
  full_text_screening: 'For an included publication with a readable PDF, the LLM can assess each criterion and point to supporting passages and physical PDF pages. This assistance is visible during review, but the eligibility decision remains yours.',
  extraction_quality: 'The LLM can suggest values for configured extraction fields and show source evidence. You choose whether to apply, edit, replace, or ignore each suggestion. In addition, if extraction validation is enabled, it can also flag submitted human values as supported, contradicted, uncertain, or not verifiable without changing them.',
  completed: 'Finally, the LLM can run a first analysis of the results generated during the review process, from importing to data extraction.',
}

const overviewPillars = [
  {
    title: 'A guided workflow',
    description: 'Six connected review stages take the project from setup and record import through screening, extraction, and analysis.',
    icon: <IconArrowRight />,
  },
  {
    title: 'Independent teamwork',
    description: 'Role-based access rules, hidden reviewing decisions, and explicit conflict resolution keep collaboration organized.',
    icon: <IconUsers />,
  },
  {
    title: 'Traceable results',
    description: 'An immutable audit trail supports PRISMA, Excel, Parquet, JSON, CSV, and BibTeX outputs you can carry into analysis and reporting.',
    icon: <IconCheckCircle />,
  },
]

function PapertrailOverview() {
  return (
    <div className="grid gap-4">
      <header className="relative overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-[radial-gradient(circle_at_92%_5%,var(--color-primary-container-hover),transparent_19rem),linear-gradient(145deg,var(--color-surface-raised),var(--color-surface))] p-4 min-[561px]:p-6">
        <span className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">Systematic review workspace</span>
        <h3 className="m-0 max-w-[720px] text-[clamp(1.25rem,2vw,1.6rem)] leading-tight">One path from search results to review-ready data</h3>
        <p className="mt-3 max-w-[720px] text-text-secondary">
          Papertrail keeps assignments, decisions, evidence, and revisions connected so
          the whole team can follow and defend the review process.
        </p>
      </header>

      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[821px]:grid-cols-3" aria-label="Papertrail at a glance">
        {overviewPillars.map((pillar) => (
          <li className="min-w-0 rounded-md border border-border bg-surface p-4" key={pillar.title}>
            <span className="mb-3 inline-flex size-10 items-center justify-center rounded-sm bg-primary-container text-primary [&_svg]:size-[21px] [&_svg]:fill-current" aria-hidden="true">{pillar.icon}</span>
            <h4 className="m-0 text-[0.98rem]">{pillar.title}</h4>
            <p className="mt-2 text-[0.88rem] text-text-secondary">{pillar.description}</p>
          </li>
        ))}
      </ul>

      <p className="m-0 flex items-start gap-3 rounded-md border border-[color-mix(in_srgb,var(--color-success)_24%,var(--color-border))] bg-success-container px-4 py-3 text-sm text-text-secondary min-[561px]:items-center [&>svg]:size-[22px] [&>svg]:shrink-0 [&>svg]:fill-success">
        <IconSparkle />
        <span>
          <strong>Reviewer judgement stays authoritative.</strong> Optional local LLM
          assistance can suggest, but it never decides or overwrites human-entered work.
        </span>
      </p>
    </div>
  )
}

function StageTimeline({
  descriptions = stageDescriptions,
  label = 'Review stages',
  centerMarkers = false,
}: {
  descriptions?: Record<string, string>
  label?: string
  centerMarkers?: boolean
}) {
  return (
    <ol
      className="m-0 grid list-none gap-5 p-0"
      data-marker-alignment={centerMarkers ? 'center' : 'start'}
      aria-label={label}
    >
      {STAGES.map((stage, index) => (
        <li
          className={`grid grid-cols-[56px_1fr] gap-4 ${centerMarkers ? 'items-center' : 'items-start'}`}
          key={stage.value}
          style={{ '--stage-color': stage.color } as CSSProperties}
        >
          <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--stage-color)_18%,transparent)] text-2xl font-bold leading-none text-(--stage-color)" aria-hidden="true">{index + 1}</span>
          <div className="border-l-[3px] border-(--stage-color) py-1 pl-4">
            <h3 className="mb-1 text-base font-bold text-(--stage-color)">{stage.label}</h3>
            <p className="text-text-secondary">{descriptions[stage.value]}</p>
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
      'Help define the research questions and inclusion/exclusion criteria.',
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
      'Use the link-reachability badges and the Crossref / Semantic Scholar suggestion as hints — they never decide for you, though a provider-confirmed same-work pair is merged automatically.',
    ],
  },
  {
    id: 'title_abstract_screening',
    name: 'Title/Abstract Screening',
    owner: [
      'Monitor reviewer progress and adjust screening assignments as needed.',
      'Choose how publications reach reviewers: "Claim" (default) lets reviewers pick up the next unclaimed publication themselves, "Divided" pre-assigns publications round-robin, weighted by each reviewer’s workload weight, and "Independent" shows every publication to every reviewer.',
      'Resolve screening conflicts and uncertain decisions according to the configured resolution method.',
    ],
    reviewer: [
      'Work the active screening queue: inspect each publication, check it against every inclusion/exclusion criterion, and decide include, exclude, uncertain, or duplicate.',
      'In independent screening, other reviewers’ answers stay hidden until all required decisions are submitted. A submitted decision can still be revised, which reopens any existing consensus.',
    ],
  },
  {
    id: 'full_text_screening',
    name: 'Full-Text Retrieval & Screening',
    owner: [
      'Track manual full-text retrieval and, together with full-text reviewers, manage publication PDFs.',
      'Resolve full-text screening conflicts.',
    ],
    reviewer: [
      'Retrieve the full text using the DOI/publisher link Papertrail provides, then upload the PDF directly from the screening page.',
      'If you’ve paired the browser extension in Account Settings, it can fetch and upload missing PDFs in the background using your own network access. More information about this below.',
      'Save the retrieval status, then complete the eligibility decision. LLM assistance, when enabled, stays visible during review and points to verified passages and physical PDF pages.',
    ],
  },
  {
    id: 'extraction_quality',
    name: 'Extraction & Quality Assessment',
    owner: [
      'Configure the project’s extraction and quality-assessment forms.',
      'Choose how publications reach extractors and quality assessors: "Claim" (default) lets reviewers pick up the next unclaimed publication themselves, "Pre-assigned" splits publications round-robin, weighted by each reviewer’s workload weight.',
      'Reopen a reviewer’s submitted extraction or quality assessment if it needs correction.',
    ],
    reviewer: [
      'Complete every required field for each publication to extract or, when enabled, quality-assess.',
      'Optional LLM suggestions appear beside each field with an explicit/inferred/ambiguous/missing status and page evidence. Apply a suggestion explicitly or enter your own data.',
    ],
  },
  {
    id: 'completed',
    name: 'Completed',
    owner: [
      'Review integrity warnings, then generate the PRISMA flow diagram, Excel workbook, Parquet dataset, JSON, CSV, and BibTeX exports.',
      'Reopen the project at an earlier stage if corrections are needed later. Downstream data is retained but excluded from active counts.',
    ],
    reviewer: [
      'Browse the results table containing all finally included publication with its extraction answers and, when enabled, quality-assessment answers and score.',
    ],
  },
]

function StageList({ role }: { role: 'owner' | 'reviewer' }) {
  return (
    <ol
      className="m-0 grid list-none gap-5 p-0"
      data-timeline="responsibilities"
      aria-label={role === 'reviewer' ? 'Reviewer responsibilities by stage' : 'Project owner responsibilities by stage'}
    >
      {stages.map((stage, index) => {
        const color = STAGES.find((item) => item.value === stage.id)?.color

        return (
          <li
            className="grid grid-cols-[56px_1fr] items-center gap-4"
            data-stage={stage.id}
            key={stage.id}
            style={{ '--stage-color': color } as CSSProperties}
          >
            <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--stage-color)_18%,transparent)] text-2xl font-bold leading-none text-(--stage-color)" aria-hidden="true">{index + 1}</span>
            <div className="border-l-[3px] border-(--stage-color) py-1 pl-4">
              <h3 className="mb-1 text-base font-bold text-(--stage-color)">{stage.name}</h3>
              <ul className="m-0 grid gap-1 pl-5 text-text-secondary">
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

function OwnerDangerZoneGuide() {
  return (
    <aside aria-label="Reset is a fresh start, delete is permanent removal">
      <CollapsibleSection
        title="Reset is a fresh start, delete is permanent removal"
        subtitle="Before using the Danger Zone"
        icon={<IconTrash />}
        className="overflow-hidden rounded-lg border-[color-mix(in_srgb,var(--color-danger)_28%,var(--color-border))] [background:radial-gradient(circle_at_100%_0,var(--color-danger-container),transparent_20rem),color-mix(in_srgb,var(--color-danger)_3%,var(--color-surface))] p-0 shadow-none [&>.collapsible-section__heading]:p-4 min-[561px]:[&>.collapsible-section__heading]:p-5 [&_.collapsible-section__heading]:text-[1.08rem] [&_.collapsible-section__icon]:size-[42px] [&_.collapsible-section__icon]:items-center [&_.collapsible-section__icon]:justify-center [&_.collapsible-section__icon]:rounded-md [&_.collapsible-section__icon]:bg-danger-container [&_.collapsible-section__icon]:text-danger [&_.collapsible-section__subtitle]:mb-1 [&_.collapsible-section__subtitle]:text-danger [&>.collapsible-section__content[data-expanded=true]]:mt-0 [&>.collapsible-section__content[data-expanded=true]]:border-t [&>.collapsible-section__content[data-expanded=true]]:border-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-border))]"
        defaultExpanded={false}
        headingLevel={3}
      >
        <div className="grid grid-cols-1 min-[821px]:grid-cols-2">
          <section className="flex min-w-0 gap-3 p-4 min-[561px]:p-5">
            <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-warning-container text-warning [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconRestart /></span>
            <div>
              <h4 className="m-0 text-[0.96rem]">Reset Project</h4>
              <p className="mt-2 text-[0.87rem] text-text-secondary">
                Returns the project to Draft and removes imported publications plus all duplicate,
                screening, full-text, extraction, and quality progress. It keeps the project itself,
                members, research questions, criteria, screening setup, and forms so the review can restart.
              </p>
            </div>
          </section>
          <section className="flex min-w-0 gap-3 border-t border-[color-mix(in_srgb,var(--color-danger)_18%,var(--color-border))] p-4 min-[561px]:p-5 min-[821px]:border-l min-[821px]:border-t-0">
            <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-danger-container text-danger [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconTrash /></span>
            <div>
              <h4 className="m-0 text-[0.96rem]">Delete Project</h4>
              <p className="mt-2 text-[0.87rem] text-text-secondary">
                Removes the entire project, including its configuration, membership, audit history,
                publications, stored PDFs, import files, exports, and progress. Running background jobs
                must finish before deletion can proceed.
              </p>
            </div>
          </section>
        </div>
      </CollapsibleSection>
    </aside>
  )
}

const llmSetupSteps = [
  {
    title: 'Choose the capabilities',
    section: 'LLM Assistance',
    description: 'Enable title/abstract screening, full-text screening, data extraction, and extraction validation independently. Test the connection, review processing status, and re-run a task from here.',
  },
  {
    title: 'Shape the extraction output',
    section: 'LLM Extraction Schema',
    description: 'Choose the extraction fields, output types, evidence requirements, and inference policy. Helper fields can add useful context without entering the official extraction response.',
  },
  {
    title: 'Add project context',
    section: 'AI Prompts',
    description: 'Review each task\'s fixed base prompt, then append custom instructions for your project. Instructions save automatically when you leave the field.',
  },
]

const extensionInstallSteps = [
  {
    title: 'Download the Browser Helper',
    section: 'Account Settings → Browser Helpers',
    description: 'Download the "papertrail-browser-extension.zip" file, then unzip it somewhere you\'ll keep, such as a "Papertrail Browser Helper" folder in Documents. Chrome loads the extension from that folder, not from the ZIP itself.',
    icon: <IconDownload />,
  },
  {
    title: 'Turn on developer mode',
    section: 'chrome://extensions',
    description: 'Open a new tab to chrome://extensions (or Menu → Extensions → Manage Extensions), then switch on the "Developer mode" toggle in the top-right corner. This unlocks the "Load unpacked" button used next.',
    icon: <IconGear />,
  },
  {
    title: 'Load the unpacked extension',
    section: '"Load unpacked" button',
    description: 'Click "Load unpacked" and select the unzipped folder (the one containing manifest.json). "Papertrail Browser Helper" now appears in your extensions list and toolbar.',
    icon: <IconFolder />,
  },
  {
    title: 'Pin it for easy access',
    section: 'Toolbar puzzle-piece icon',
    description: 'Click the puzzle-piece icon in Chrome\'s toolbar and pin "Papertrail Browser Helper" so its icon, and pairing status, stay visible.',
    icon: <IconCheckCircle />,
  },
]

const extensionSetupSteps = [
  {
    title: 'Pair the extension',
    section: 'Account Settings → Browser Helpers',
    description: 'Generate a pairing secret in your Account settings (valid for 10 minutes and usable once) then enter your server URL, the secret, and a device name on the extension\'s setup page.',
  },
  {
    title: 'Allow publisher access',
    section: 'One-time permission prompt',
    description: 'The first time it retrieves a paper, the extension asks for a single broad HTTPS permission, since the publisher domain is only known after following each DOI. It never receives your login credentials or cookies.',
  },
  {
    title: 'Capture the page you have open',
    section: 'Extension icon → "Capture PDF from this tab"',
    description: 'With an article or PDF open in the active tab, choose a project and "Capture PDF from this tab" to search for the matching publication (or create a new one on the spot) and add the file to Papertrail immediately.',
  },
  {
    title: 'Let retrieval run',
    section: 'Automatic or on demand',
    description: 'Including a publication during title/abstract screening queues it automatically once you have a paired helper. Anyone with the full-text reviewer role can also start, retry, or cancel a batch from Publications → "Retrieve missing PDFs".',
  },
]

const extensionPracticalNotes = [
  {
    title: 'Uses your own access',
    description: 'Retrieval runs through your browser\'s own network connection and existing sign-in through university IP access, VPN, or an institutional login already open in Chrome. Papertrail never receives your publisher credentials or cookies, only the resulting PDF.',
    icon: <IconInfo />,
  },
  {
    title: 'Read the toolbar badge',
    description: 'The extension icon\'s badge shows how many PDFs are queued and waiting to be retrieved. It turns green and says "ON" once you\'re paired with nothing queued, and stays blank if the extension isn\'t paired yet.',
    icon: <IconClock />,
  },
  {
    title: 'Coverage varies by publisher',
    description: 'Dedicated support for ACM, IEEE, Springer, and ScienceDirect, with a generic fallback for other sites. Requires Chrome 116 or later, and PDFs over 50 MB are rejected.',
    icon: <IconCheckCircle />,
  },
  {
    title: 'A miss still needs a human',
    description: 'An automated failure such as an authentication wall, access denied, or not found is flagged. It surfaces under "Publications needing attention" so a reviewer can try another way.',
    icon: <IconPerson />,
  },
]

const setupStepsClassName = 'm-0 mt-5 grid list-none grid-cols-1 gap-3 p-0 min-[761px]:grid-cols-3'
const installStepsClassName = 'm-0 mt-5 grid list-none grid-cols-1 gap-3 p-0 min-[641px]:grid-cols-2'
const setupStepClassName = 'flex min-w-0 gap-3 rounded-md border border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-surface-raised)_90%,transparent)] p-4 shadow-sm'
const setupStepIconClassName = 'inline-flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary-container text-primary [&_svg]:size-4 [&_svg]:fill-current'
const practicalNotesClassName = 'grid content-start gap-4 border-t border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_55%,transparent)] p-4 min-[481px]:p-6 min-[761px]:border-l min-[761px]:border-t-0'
const practicalNoteClassName = 'flex gap-3 [&>span]:inline-flex [&>span]:size-9 [&>span]:shrink-0 [&>span]:items-center [&>span]:justify-center [&>span]:rounded-sm [&>span]:bg-primary-container [&>span]:text-primary [&>span_svg]:size-[22px] [&>span_svg]:fill-current [&_h4]:m-0 [&_h4]:text-[0.94rem] [&_p]:mt-2 [&_p]:text-[0.88rem] [&_p]:text-text-secondary'

const goodToKnowItems = [
  {
    label: 'Full-text access',
    title: 'Upload with permission',
    description: 'The Papertrail server never scrapes publisher PDFs itself. Only add files you are authorized to access and store, whether uploaded directly or retrieved through the optional browser extension.',
    icon: <IconUpload />,
    tone: 'primary',
  },
  {
    label: 'Browser extension',
    title: 'Retrieve PDFs through your own sign-in',
    description: 'Pair the optional Papertrail Browser Helper Chrome extension in Account Settings to fetch publisher PDFs using your own computer\'s network access to databases like IEEE Xplore or ACM Digital Library.',
    icon: <IconDownload />,
    tone: 'success',
  },
  {
    label: 'Human judgement',
    title: 'You stay in control',
    description: 'LLM assistance is advisory and project-specific. It can support your review, but it never overrides a reviewer\'s decision.',
    icon: <IconPerson />,
    tone: 'success',
  },
  {
    label: 'Work reservations',
    title: 'Claims expire automatically',
    description: 'An opened screening item stays reserved to you for up to one hour, so work cannot remain blocked indefinitely.',
    icon: <IconClock />,
    tone: 'warning',
  },
  {
    label: 'Screening shortcuts',
    title: 'Faster with a keyboard',
    description: 'Arrow keys move between criteria and Left/Right answer them. Include, Exclude, Uncertain, Duplicate and Submit each have a keyboard shortcut. Reassign or clear the shortcuts under Account Settings → Screening Hotkeys.',
    icon: <IconKeyboard />,
    tone: 'success',
  },
  {
    label: 'Document history',
    title: 'Earlier PDFs stay traceable',
    description: 'Replacing a PDF creates a new version. Removing one preserves its history and never changes an existing screening decision.',
    icon: <IconRestart />,
    tone: 'primary',
  },
  {
    label: 'Notifications',
    title: 'Your inbox is optional',
    description: 'Update or clear your notification email address at any time under Account Settings.',
    icon: <IconInfo />,
    tone: 'success',
  },
  {
    label: 'Joining mid-project',
    title: 'New reviewers share the remaining work',
    description: 'A new reviewer only receives activities the project owner enables for them. Papertrail then balances unclaimed screening, extraction, and quality work fairly across everyone who is eligible.',
    icon: <IconUsers />,
    tone: 'primary',
  },
  {
    label: 'Adding publications',
    title: 'Import a collection or add one record',
    description: 'Use Import Records for CSV, TSV, XLSX, RIS, or BibTeX database exports. For a single publication, enter it manually or upload or paste BibTeX to prefill the form.',
    icon: <IconPlus />,
    tone: 'success',
  },
  {
    label: 'Uploading PDFs',
    title: 'Attach full text wherever it fits',
    description: 'Add PDFs or ZIP archives with a record import, attach them to an earlier import batch, bulk-match them across Publications, attach one while adding or editing a publication, or upload directly during full-text screening.',
    icon: <IconUpload />,
    tone: 'primary',
  },
  {
    label: 'Charts & Analysis',
    title: 'See patterns across every review stage',
    description: 'Review deduplication totals, screening and retrieval outcomes, exclusion reasons, extraction completeness and distributions, and quality scores. Stage summaries help surface trends and gaps as the underlying project data changes.',
    icon: <IconSparkle />,
    tone: 'warning',
  },
  {
    label: 'Revisiting decisions',
    title: 'The latest decision guides what happens next',
    description: 'Revising a submitted screening decision creates a new version and re-evaluates consensus. Late inclusions receive any missing downstream work, while newly ineligible work stays traceable but drops out of the active workflow.',
    icon: <IconSwap />,
    tone: 'warning',
  },
]

const tipToneClassName: Record<string, string> = {
  primary: '[--tip-accent:var(--color-primary)]',
  success: '[--tip-accent:var(--color-success)]',
  warning: '[--tip-accent:var(--color-warning)]',
}

function LlmHelpSection() {
  return (
    <CollapsibleSection id="section-help-llm" title="LLM Assistance" icon={<IconSparkle />}>
      <p>
        LLM assistance is optional and advisory. LLM tasks can be individually turned on
        or off for the individual review stages. A suggestion is never automatically applied
        as a screening decision, overwrites reviewer work, or blocks the normal
        workflow when processing is unavailable or fails.
      </p>
      <aside className="flex items-start gap-3 rounded-md border border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-primary-container p-4" aria-label="LLM background processing">
        <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-surface text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconClock /></span>
        <div>
          <h3 className="m-0 text-[0.98rem]">Results arrive in the background</h3>
          <p className="mt-2 text-sm text-text-secondary">
            LLM assistance is processed by background jobs, so suggestions can take some time
            to appear. You can continue screening or extracting before the LLM result is ready
            and review it after processing finishes.
          </p>
        </div>
      </aside>
      <StageTimeline
        descriptions={llmStageDescriptions}
        label="LLM assistance by review stage"
        centerMarkers
      />

      <CollapsibleSection
        title="Configuring LLM assistance and custom prompts"
        subtitle="For project owners and administrators"
        icon={<IconSparkle />}
        className="relative overflow-hidden rounded-lg border-border [background:radial-gradient(circle_at_100%_0,var(--color-primary-container-hover),transparent_20rem),var(--color-surface)] p-4 shadow-none min-[481px]:p-6 [&_.collapsible-section__heading]:m-0 [&_.collapsible-section__heading]:text-[1.16rem] [&>.collapsible-section__heading_.collapsible-section__icon]:size-[42px] [&>.collapsible-section__heading_.collapsible-section__icon]:items-center [&>.collapsible-section__heading_.collapsible-section__icon]:justify-center [&>.collapsible-section__heading_.collapsible-section__icon]:rounded-md [&>.collapsible-section__heading_.collapsible-section__icon]:bg-primary-container [&>.collapsible-section__heading_.collapsible-section__subtitle]:mb-1 [&>.collapsible-section__heading_.collapsible-section__subtitle]:text-primary"
        defaultExpanded={false}
        headingLevel={3}
      >
        <p className="m-0 max-w-[720px] text-text-secondary">
          Open <strong>Project Administration</strong> and work through these three areas.
          Each one controls a different layer of the assistance reviewers see.
        </p>
        <ol className={setupStepsClassName} aria-label="LLM configuration steps">
          {llmSetupSteps.map((step, index) => (
            <li className={setupStepClassName} key={step.section}>
              <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary-container text-[0.84rem] font-bold text-primary" aria-hidden="true">{index + 1}</span>
              <div>
                <span className="mb-1 block text-xs font-bold text-primary">{step.section}</span>
                <h4 className="m-0 text-[0.94rem]">{step.title}</h4>
                <p className="mt-2 text-[0.88rem] text-text-secondary">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <section className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-surface min-[761px]:grid-cols-[minmax(0,1.25fr)_minmax(260px,0.75fr)]" aria-labelledby="help-prompt-guide-title">
          <div className="p-4 min-[481px]:p-6">
            <header className="flex items-center gap-3">
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-warning-container text-warning [&_svg]:size-[22px] [&_svg]:fill-current" aria-hidden="true"><IconLightbulb /></span>
              <div>
                <span className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">Prompt guidance</span>
                <h3 className="m-0 text-[1.16rem]" id="help-prompt-guide-title">Writing useful custom instructions</h3>
              </div>
            </header>
            <ul className="mt-5 grid list-none gap-3 p-0 [&_strong]:text-[0.92rem] [&_span]:text-[0.88rem] [&_span]:text-text-secondary">
              <li className="relative grid gap-0.5 pl-5 before:absolute before:left-0.5 before:top-[0.48rem] before:size-[7px] before:rounded-full before:bg-primary before:shadow-[0_0_0_4px_var(--color-primary-container)]">
                <strong>Use the project's language</strong>
                <span>Define domain terms, abbreviations, and concepts the model must distinguish.</span>
              </li>
              <li className="relative grid gap-0.5 pl-5 before:absolute before:left-0.5 before:top-[0.48rem] before:size-[7px] before:rounded-full before:bg-primary before:shadow-[0_0_0_4px_var(--color-primary-container)]">
                <strong>Clarify judgement calls</strong>
                <span>Explain how project criteria should be interpreted when the source is unclear.</span>
              </li>
              <li className="relative grid gap-0.5 pl-5 before:absolute before:left-0.5 before:top-[0.48rem] before:size-[7px] before:rounded-full before:bg-primary before:shadow-[0_0_0_4px_var(--color-primary-container)]">
                <strong>Keep the scope focused</strong>
                <span>Highlight what deserves attention without repeating the entire protocol.</span>
              </li>
            </ul>
            <p className="mt-5 border-l-[3px] border-warning bg-warning-container px-4 py-3 text-[0.88rem] text-text-secondary">
              Custom instructions supplement the base prompt. They cannot relax its evidence,
              safety, or output-format rules.
            </p>
          </div>

          <aside className={practicalNotesClassName} aria-label="Practical LLM guidance">
            <div className={practicalNoteClassName}>
              <span aria-hidden="true"><IconRestart /></span>
              <div>
                <h4>Re-run after edits</h4>
                <p>Prompt changes affect future processing. Re-run a task to refresh existing suggestions.</p>
              </div>
            </div>
            <div className={practicalNoteClassName}>
              <span aria-hidden="true"><IconCheckCircle /></span>
              <div>
                <h4>Verify every result</h4>
                <p>Check suggestions against the publication, especially inferred, ambiguous, or unverified evidence.</p>
              </div>
            </div>
            <div className={practicalNoteClassName}>
              <span aria-hidden="true"><IconInfo /></span>
              <div>
                <h4>Text and privacy</h4>
                <p>Papertrail cannot OCR image-only PDFs. Ollama receives the material needed for each task, so follow your installation's data policy.</p>
              </div>
            </div>
          </aside>
        </section>
      </CollapsibleSection>
    </CollapsibleSection>
  )
}

function ExtensionOverviewSection() {
  return (
    <CollapsibleSection id="section-help-extension-overview" title="What It Does" icon={<IconDownload />}>
      <p>
        The Papertrail Browser Helper is an optional Chrome extension that retrieves publisher
        PDFs using your own computer's network access and sign-in, then uploads them through the
        same review pipeline as a manual upload. Papertrail itself never scrapes publisher sites,
        and it isn't published on the Chrome Web Store. You install it from a ZIP downloaded
        straight from this Papertrail server.
      </p>
      <aside className="flex items-start gap-3 rounded-md border border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-primary-container p-4" aria-label="Browser extension background processing">
        <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-surface text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconDownload /></span>
        <div>
          <h3 className="m-0 text-[0.98rem]">Runs quietly in the background</h3>
          <p className="mt-2 text-sm text-text-secondary">
            Once paired, a background service worker can claim queued retrieval jobs.
            Every result still goes through the same staged-upload
            validation as a manually attached PDF before it counts as available, so an automated
            upload never bypasses reviewer verification.
          </p>
        </div>
      </aside>
      <aside className={practicalNotesClassName} aria-label="Practical browser extension guidance">
        {extensionPracticalNotes.map((note) => (
          <div className={practicalNoteClassName} key={note.title}>
            <span aria-hidden="true">{note.icon}</span>
            <div>
              <h4>{note.title}</h4>
              <p>{note.description}</p>
            </div>
          </div>
        ))}
      </aside>
    </CollapsibleSection>
  )
}

function ExtensionInstallSection() {
  return (
    <CollapsibleSection id="section-help-extension-install" title="Install in Chrome" icon={<IconGear />}>
      <p>
        Because the Browser Helper isn't distributed through the Chrome Web Store, Chrome treats it
        as an unpacked developer extension. That just means one extra "Developer mode" step
        compared to installing something from the Web Store.
      </p>
      <div className={toolbarClass}>
        <Button as="a" href="/api/v1/browser-agents/extension-download" variant="primary">
          <IconDownload />
          Download Browser Helper (.zip)
        </Button>
      </div>
      <ol className={installStepsClassName} aria-label="Chrome installation steps">
        {extensionInstallSteps.map((step, index) => (
          <li className={setupStepClassName} key={step.section}>
            <span className={setupStepIconClassName} aria-hidden="true">{step.icon}</span>
            <div>
              <span className="mb-1 block text-xs font-bold text-primary">{index + 1}. {step.section}</span>
              <h4 className="m-0 text-[0.94rem]">{step.title}</h4>
              <p className="mt-2 text-[0.88rem] text-text-secondary">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="m-0 mt-5 border-l-[3px] border-warning bg-warning-container px-4 py-3 text-[0.88rem] text-text-secondary">
        Requires Chrome (or another Chromium-based browser) version 116 or later. Chrome may
        occasionally disable unpacked extensions after a browser restart. If the Browser Helper
        disappears from chrome://extensions, repeat the "Load unpacked" step from the same folder.
      </p>
    </CollapsibleSection>
  )
}

function ExtensionUseSection() {
  return (
    <CollapsibleSection id="section-help-extension-use" title="Pair & Use" icon={<IconCheckCircle />}>
      <p>
        Once loaded into Chrome, the extension needs to be paired with your Papertrail account
        before it can retrieve anything.
      </p>
      <ol className={setupStepsClassName} aria-label="Browser extension pairing steps">
        {extensionSetupSteps.map((step, index) => (
          <li className={setupStepClassName} key={step.section}>
            <span className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-primary-container text-[0.84rem] font-bold text-primary" aria-hidden="true">{index + 1}</span>
            <div>
              <span className="mb-1 block text-xs font-bold text-primary">{step.section}</span>
              <h4 className="m-0 text-[0.94rem]">{step.title}</h4>
              <p className="mt-2 text-[0.88rem] text-text-secondary">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-text-secondary">
        Manage or revoke a paired helper any time from <strong>Account Settings → Browser
        Helpers</strong>. Revoking one immediately stops it from claiming further retrieval jobs.
      </p>
    </CollapsibleSection>
  )
}

export function HelpPage() {
  const [activeTab, setActiveTab] = useState<HelpTabId>('getting-started')
  const currentTab = helpTabs.find((tab) => tab.id === activeTab) ?? helpTabs[0]

  return (
    <SectionNavigationLayout items={currentTab.sections} label="On this page">
      <Page>
        <h1>Help</h1>
        <p className="text-text-muted">Documentation and guidance for using Papertrail.</p>
        <TabList
          idPrefix="help"
          label="Help sections"
          activeId={activeTab}
          onSelect={(id) => setActiveTab(id as HelpTabId)}
          className="mb-6"
          items={helpTabs.map((tab) => ({ id: tab.id, label: <>{tab.icon}{tab.label}</> }))}
        />
        <TabPanel idPrefix="help" id={activeTab}>
          {activeTab === 'getting-started' ? (
            <>
              <CollapsibleSection id="section-help-overview" title="What Papertrail Does" icon={<IconInfo />}>
                <PapertrailOverview />
              </CollapsibleSection>
              <CollapsibleSection id="section-help-stages" title="The Review Stages" icon={<IconArrowRight />}>
                <StageTimeline />
              </CollapsibleSection>
            </>
          ) : null}
          {activeTab === 'roles' ? (
            <>
              <CollapsibleSection id="section-help-reviewer" title="As a Reviewer" icon={<IconUsers />}>
                <p>
                  A reviewer is any member added to a project. You only see the projects you belong to,
                  and only the actions you are assigned to.
                </p>
                <StageList role="reviewer" />
              </CollapsibleSection>
              <CollapsibleSection id="section-help-owner" title="As a Project Owner" icon={<IconFolder />}>
                <p>
                  The project owner is whoever created the project. Alongside the stage-by-stage
                  responsibilities below, an owner can manage members and their eligibility, project
                  details and highlighted keywords, LLM assistance settings, the audit log, and
                  lifecycle actions such as resetting or deleting the project.
                </p>
                <StageList role="owner" />
                <OwnerDangerZoneGuide />
              </CollapsibleSection>
            </>
          ) : null}
          {activeTab === 'ai-automation' ? (
            <LlmHelpSection />
          ) : null}
          {activeTab === 'browser-extension' ? (
            <>
              <ExtensionOverviewSection />
              <ExtensionInstallSection />
              <ExtensionUseSection />
            </>
          ) : null}
          {activeTab === 'good-to-know' ? (
            <CollapsibleSection id="section-help-good-to-know" title="Good to Know" icon={<IconLightbulb />}>
              <div className="grid gap-4">
                <header className="grid grid-cols-1 items-center gap-4 overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--color-warning)_28%,var(--color-border))] bg-[radial-gradient(circle_at_92%_-25%,var(--color-warning-container),transparent_18rem),linear-gradient(135deg,var(--color-surface-raised),var(--color-surface))] p-4 min-[561px]:grid-cols-[auto_minmax(0,1fr)] min-[561px]:px-6 min-[561px]:py-5">
                  <span className="inline-flex size-[54px] items-center justify-center rounded-lg bg-warning-container text-warning shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-warning)_20%,transparent)] [&_svg]:size-7 [&_svg]:fill-current" aria-hidden="true">
                    <IconLightbulb />
                  </span>
                  <div>
                    <span className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">Practical details</span>
                    <h3 className="m-0 text-[1.16rem]">Small things that keep a review moving</h3>
                    <p className="mt-2 max-w-[700px] text-text-secondary">
                      Keep these safeguards and workflow details in mind as your project moves
                      from imported records to final results.
                    </p>
                  </div>
                </header>

                <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[561px]:grid-cols-2 min-[821px]:grid-cols-6" aria-label="Helpful things to know">
                  {goodToKnowItems.map((item) => (
                    <li
                      className={`relative flex min-w-0 gap-3 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--tip-accent)_22%,var(--color-border))] bg-[color-mix(in_srgb,var(--tip-accent)_5%,var(--color-surface))] p-4 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-(--tip-accent) min-[821px]:col-span-2 ${tipToneClassName[item.tone]}`}
                      data-help-tip={item.tone}
                      key={item.title}
                    >
                      <span className="inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_srgb,var(--tip-accent)_13%,transparent)] text-(--tip-accent) [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true">
                        {item.icon}
                      </span>
                      <div>
                        <span className="mb-0.5 block text-xs font-bold uppercase tracking-[0.055em] text-(--tip-accent)">{item.label}</span>
                        <h4 className="m-0 text-[0.95rem]">{item.title}</h4>
                        <p className="mt-2 text-[0.87rem] text-text-secondary">{item.description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </CollapsibleSection>
          ) : null}
        </TabPanel>
      </Page>
    </SectionNavigationLayout>
  )
}
