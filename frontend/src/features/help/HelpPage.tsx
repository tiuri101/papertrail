import type { CSSProperties } from 'react'

import { CollapsibleSection } from '../../components/CollapsibleSection'
import {
  IconArrowRight,
  IconCheckCircle,
  IconClock,
  IconDownload,
  IconFolder,
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
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { STAGES } from '../projects/StageProgress'

const helpSections = [
  { id: 'section-help-overview', label: 'Overview' },
  { id: 'section-help-stages', label: 'Review Stages' },
  { id: 'section-help-reviewer', label: 'Reviewer' },
  { id: 'section-help-owner', label: 'Project Owner' },
  { id: 'section-help-llm', label: 'LLM Assistance' },
  { id: 'section-help-extension', label: 'Browser Extension' },
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
    description: 'An immutable audit trail supports PRISMA, Excel, and BibTeX outputs you can carry into analysis and reporting.',
    icon: <IconCheckCircle />,
  },
]

function PapertrailOverview() {
  return (
    <div className="help-overview">
      <header className="help-overview__hero">
        <span className="eyebrow">Systematic review workspace</span>
        <h3>One path from search results to review-ready data</h3>
        <p>
          Papertrail keeps assignments, decisions, evidence, and revisions connected so
          the whole team can follow and defend the review process.
        </p>
      </header>

      <ul className="help-overview__pillars" aria-label="Papertrail at a glance">
        {overviewPillars.map((pillar) => (
          <li key={pillar.title}>
            <span className="help-overview__pillar-icon" aria-hidden="true">{pillar.icon}</span>
            <h4>{pillar.title}</h4>
            <p>{pillar.description}</p>
          </li>
        ))}
      </ul>

      <p className="help-overview__principle">
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
      className={`help-stage-timeline${centerMarkers ? ' help-stage-timeline--centered' : ''}`}
      aria-label={label}
    >
      {STAGES.map((stage, index) => (
        <li
          className="help-stage-timeline__item"
          key={stage.value}
          style={{ '--stage-color': stage.color } as CSSProperties}
        >
          <span className="help-stage-timeline__number" aria-hidden="true">{index + 1}</span>
          <div className="help-stage-timeline__body">
            <h3>{stage.label}</h3>
            <p>{descriptions[stage.value]}</p>
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
      'Review integrity warnings, then generate the PRISMA flow diagram, Excel workbook, and BibTeX export.',
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

function OwnerDangerZoneGuide() {
  return (
    <aside aria-label="Reset is a fresh start, delete is permanent removal">
      <CollapsibleSection
        title="Reset is a fresh start, delete is permanent removal"
        subtitle="Before using the Danger Zone"
        icon={<IconTrash />}
        className="help-owner-danger"
        defaultExpanded={false}
        headingLevel={3}
      >
        <div className="help-owner-danger__options">
          <section>
            <span className="help-owner-danger__icon" aria-hidden="true"><IconRestart /></span>
            <div>
              <h4>Reset Project</h4>
              <p>
                Returns the project to Draft and removes imported publications plus all duplicate,
                screening, full-text, extraction, and quality progress. It keeps the project itself,
                members, research questions, criteria, screening setup, and forms so the review can restart.
              </p>
            </div>
          </section>
          <section>
            <span className="help-owner-danger__icon" aria-hidden="true"><IconTrash /></span>
            <div>
              <h4>Delete Project</h4>
              <p>
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

const extensionSetupSteps = [
  {
    title: 'Pair the extension',
    section: 'Account Settings → Browser Helpers',
    description: 'Generate a pairing secret (valid for 10 minutes and usable once) then enter your server URL, the secret, and a device name on the extension\'s setup page.',
  },
  {
    title: 'Allow publisher access',
    section: 'One-time permission prompt',
    description: 'The first time it retrieves a paper, the extension asks for a single broad HTTPS permission, since the publisher domain is only known after following each DOI. It never receives your login credentials or cookies.',
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

function LlmHelpSection() {
  return (
    <CollapsibleSection id="section-help-llm" title="LLM Assistance" icon={<IconSparkle />}>
      <p>
        LLM assistance is optional and advisory. LLM tasks can be individually turned on
        or off for the individual review stages. A suggestion is never automatically applied
        as a screening decision, overwrites reviewer work, or blocks the normal
        workflow when processing is unavailable or fails.
      </p>
      <aside className="help-llm-background-note" aria-label="LLM background processing">
        <span className="help-llm-background-note__icon" aria-hidden="true"><IconClock /></span>
        <div>
          <h3>Results arrive in the background</h3>
          <p>
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
        className="help-llm-configuration"
        defaultExpanded={false}
        headingLevel={3}
      >
        <p className="help-llm-configuration__intro">
          Open <strong>Project Administration</strong> and work through these three areas.
          Each one controls a different layer of the assistance reviewers see.
        </p>
        <ol className="help-llm-setup-steps" aria-label="LLM configuration steps">
          {llmSetupSteps.map((step, index) => (
            <li key={step.section}>
              <span className="help-llm-setup-steps__number" aria-hidden="true">{index + 1}</span>
              <div>
                <span className="help-llm-setup-steps__section">{step.section}</span>
                <h4>{step.title}</h4>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <section className="help-prompt-guide" aria-labelledby="help-prompt-guide-title">
          <div className="help-prompt-guide__main">
            <header className="help-prompt-guide__heading">
              <span className="help-prompt-guide__icon" aria-hidden="true"><IconLightbulb /></span>
              <div>
                <span className="eyebrow">Prompt guidance</span>
                <h3 id="help-prompt-guide-title">Writing useful custom instructions</h3>
              </div>
            </header>
            <ul className="help-prompt-principles">
              <li>
                <strong>Use the project's language</strong>
                <span>Define domain terms, abbreviations, and concepts the model must distinguish.</span>
              </li>
              <li>
                <strong>Clarify judgement calls</strong>
                <span>Explain how project criteria should be interpreted when the source is unclear.</span>
              </li>
              <li>
                <strong>Keep the scope focused</strong>
                <span>Highlight what deserves attention without repeating the entire protocol.</span>
              </li>
            </ul>
            <p className="help-prompt-guide__boundary">
              Custom instructions supplement the base prompt. They cannot relax its evidence,
              safety, or output-format rules.
            </p>
          </div>

          <aside className="help-llm-practical-notes" aria-label="Practical LLM guidance">
            <div className="help-llm-practical-note">
              <span aria-hidden="true"><IconRestart /></span>
              <div>
                <h4>Re-run after edits</h4>
                <p>Prompt changes affect future processing. Re-run a task to refresh existing suggestions.</p>
              </div>
            </div>
            <div className="help-llm-practical-note">
              <span aria-hidden="true"><IconCheckCircle /></span>
              <div>
                <h4>Verify every result</h4>
                <p>Check suggestions against the publication, especially inferred, ambiguous, or unverified evidence.</p>
              </div>
            </div>
            <div className="help-llm-practical-note">
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

function ExtensionHelpSection() {
  return (
    <CollapsibleSection id="section-help-extension" title="Browser Extension" icon={<IconDownload />}>
      <p>
        The Papertrail Browser Helper is an optional Chrome extension that retrieves publisher
        PDFs using your own computer's network access and sign-in, then uploads them through the
        same review pipeline as a manual upload. Papertrail itself never scrapes publisher sites.
      </p>
      <aside className="help-llm-background-note" aria-label="Browser extension background processing">
        <span className="help-llm-background-note__icon" aria-hidden="true"><IconDownload /></span>
        <div>
          <h3>Runs quietly in the background</h3>
          <p>
            Once paired, a background service worker can claim queued retrieval jobs without
            keeping any window open. Every result still goes through the same staged-upload
            validation as a manually attached PDF before it counts as available, so an automated
            upload never bypasses reviewer verification.
          </p>
        </div>
      </aside>
      <ol className="help-llm-setup-steps" aria-label="Browser extension setup steps">
        {extensionSetupSteps.map((step, index) => (
          <li key={step.section}>
            <span className="help-llm-setup-steps__number" aria-hidden="true">{index + 1}</span>
            <div>
              <span className="help-llm-setup-steps__section">{step.section}</span>
              <h4>{step.title}</h4>
              <p>{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <aside className="help-llm-practical-notes" aria-label="Practical browser extension guidance">
        {extensionPracticalNotes.map((note) => (
          <div className="help-llm-practical-note" key={note.title}>
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

export function HelpPage() {
  return (
    <SectionNavigationLayout items={helpSections} label="On this page">
      <main className="page">
        <h1>Help</h1>
        <p className="muted">Documentation and guidance for using Papertrail.</p>
        <CollapsibleSection id="section-help-overview" title="What Papertrail Does" icon={<IconInfo />}>
          <PapertrailOverview />
        </CollapsibleSection>
        <CollapsibleSection id="section-help-stages" title="The Review Stages" icon={<IconArrowRight />}>
          <StageTimeline />
        </CollapsibleSection>
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
        <LlmHelpSection />
        <ExtensionHelpSection />
        <CollapsibleSection id="section-help-good-to-know" title="Good to Know" icon={<IconLightbulb />}>
          <div className="help-good-to-know">
            <header className="help-good-to-know__intro">
              <span className="help-good-to-know__intro-icon" aria-hidden="true">
                <IconLightbulb />
              </span>
              <div>
                <span className="eyebrow">Practical details</span>
                <h3>Small things that keep a review moving</h3>
                <p>
                  Keep these safeguards and workflow details in mind as your project moves
                  from imported records to final results.
                </p>
              </div>
            </header>

            <ul className="help-good-to-know__grid" aria-label="Helpful things to know">
              {goodToKnowItems.map((item) => (
                <li
                  className={`help-good-to-know__card help-good-to-know__card--${item.tone}`}
                  key={item.title}
                >
                  <span className="help-good-to-know__card-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <div>
                    <span className="help-good-to-know__label">{item.label}</span>
                    <h4>{item.title}</h4>
                    <p>{item.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </CollapsibleSection>
      </main>
    </SectionNavigationLayout>
  )
}
