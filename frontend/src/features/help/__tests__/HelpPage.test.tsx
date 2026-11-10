import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HelpPage } from '../HelpPage'
import { renderWithProviders } from '../../../test/render'

function goToTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }))
}

describe('HelpPage', () => {
  it('presents Getting Started, Roles & Responsibilities, AI & Automation, Browser Extension, and Good to Know as tabs', () => {
    renderWithProviders(<HelpPage />)

    expect(screen.getByRole('heading', { name: 'Help' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Getting Started',
      'Roles & Responsibilities',
      'AI & Automation',
      'Browser Extension',
      'Good to Know',
    ])
    expect(screen.getByRole('tab', { name: 'Getting Started' })).toHaveAttribute('aria-selected', 'true')
  })

  it('shows the overview and review stages under Getting Started by default', () => {
    renderWithProviders(<HelpPage />)

    expect(screen.getByRole('button', { name: 'What Papertrail Does' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'The Review Stages' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'As a Reviewer' })).not.toBeInTheDocument()
  })

  it('describes both roles for every project stage under Roles & Responsibilities', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Roles & Responsibilities')

    expect(screen.getByRole('button', { name: 'As a Project Owner' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'As a Reviewer' })).toBeInTheDocument()

    const ownerHeadings = screen.getAllByRole('heading', { name: 'Extraction & Quality Assessment' })
    const reviewerHeadings = screen.getAllByRole('heading', { name: 'Completed' })
    expect(ownerHeadings.length).toBeGreaterThan(0)
    expect(reviewerHeadings.length).toBeGreaterThan(0)
  })

  it('summarizes Papertrail in three focused visual pillars', () => {
    renderWithProviders(<HelpPage />)

    const overview = screen.getByRole('list', { name: 'Papertrail at a glance' })
    expect(overview.children).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'A guided workflow' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Independent teamwork' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Traceable results' })).toBeInTheDocument()
    expect(screen.getByText(/Reviewer judgement stays authoritative/)).toBeInTheDocument()
  })

  it('explains mid-project reviewer allocation under Good to Know', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Good to Know')

    const card = screen.getByRole('heading', { name: 'New reviewers share the remaining work' }).closest('li')
    expect(document.querySelector('#section-help-good-to-know')).toContainElement(card)
    expect(card).toHaveTextContent('only receives activities the project owner enables')
    expect(card).toHaveTextContent('balances unclaimed screening, extraction, and quality work')
    expect(card).not.toHaveTextContent('Work already underway')
  })

  it('contrasts resetting and deleting a project after the owner stage guidance', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Roles & Responsibilities')

    const ownerTimeline = screen.getByRole('list', { name: 'Project owner responsibilities by stage' })
    const dangerGuide = screen.getByRole('complementary', { name: 'Reset is a fresh start, delete is permanent removal' })
    const dangerToggle = screen.getByRole('button', { name: 'Reset is a fresh start, delete is permanent removal' })
    expect(ownerTimeline.compareDocumentPosition(dangerGuide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dangerToggle).toHaveTextContent('Before using the Danger Zone')
    expect(dangerToggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(dangerToggle)

    expect(dangerToggle).toHaveAttribute('aria-expanded', 'true')
    expect(dangerGuide).toHaveTextContent('Returns the project to Draft')
    expect(dangerGuide).toHaveTextContent('keeps the project itself, members, research questions, criteria, screening setup, and forms')
    expect(dangerGuide).toHaveTextContent('Removes the entire project')
    expect(dangerGuide).toHaveTextContent('Running background jobs must finish')
  })

  it('explains LLM support by stage and how project prompts are configured', () => {
    renderWithProviders(<HelpPage />)
    goToTab('AI & Automation')

    const timeline = screen.getByRole('list', { name: 'LLM assistance by review stage' })
    expect(timeline.children).toHaveLength(6)
    expect(timeline).toHaveTextContent('Duplicate review is entirely human-led')
    expect(timeline).toHaveTextContent('suggest values for configured extraction fields')
    const backgroundNote = screen.getByRole('complementary', { name: 'LLM background processing' })
    expect(backgroundNote).toHaveTextContent('processed by background jobs')
    expect(backgroundNote).toHaveTextContent('suggestions can take some time to appear')
    expect(backgroundNote).toHaveTextContent('continue screening or extracting before the LLM result is ready')
    const configurationToggle = screen.getByRole('button', { name: 'Configuring LLM assistance and custom prompts' })
    const configurationCard = configurationToggle.closest('section')
    expect(configurationToggle).toHaveTextContent('For project owners and administrators')
    expect(configurationToggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(configurationToggle)

    expect(configurationToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: 'LLM configuration steps' }).children).toHaveLength(3)
    expect(screen.getByText('AI Prompts')).toBeInTheDocument()
    expect(screen.getByText(/Prompt changes affect future processing/)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Practical LLM guidance' })).toBeInTheDocument()
    expect(configurationCard).toContainElement(
      screen.getByRole('heading', { name: 'Writing useful custom instructions' }),
    )
  })

  it('gives the browser extension its own Help tab, separate from AI & Automation', () => {
    renderWithProviders(<HelpPage />)
    goToTab('AI & Automation')

    expect(screen.queryByText('What It Does')).not.toBeInTheDocument()
    expect(document.querySelector('#section-help-extension-overview')).not.toBeInTheDocument()
  })

  it('describes the browser extension: what it does, how it works, and requirements', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Browser Extension')

    expect(screen.getByRole('button', { name: 'What It Does' })).toBeInTheDocument()

    const backgroundNote = screen.getByRole('complementary', { name: 'Browser extension background processing' })
    expect(backgroundNote).toHaveTextContent('Runs quietly in the background')
    expect(backgroundNote).toHaveTextContent('same staged-upload validation as a manually attached PDF')

    const practicalNotes = screen.getByRole('complementary', { name: 'Practical browser extension guidance' })
    expect(practicalNotes).toHaveTextContent('Chrome 116 or later')
    expect(practicalNotes).toHaveTextContent('never receives your publisher credentials or cookies')
    expect(practicalNotes).toHaveTextContent('Publications needing attention')
    expect(practicalNotes).toHaveTextContent('how many PDFs are queued and waiting to be retrieved')
    expect(practicalNotes).toHaveTextContent('turns green and says "ON"')
  })

  it('explains how to install the extension in Chrome, with a download link', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Browser Extension')

    expect(screen.getByRole('button', { name: 'Install in Chrome' })).toBeInTheDocument()

    const downloadLink = screen.getByRole('link', { name: /Download Browser Helper/ })
    expect(downloadLink).toHaveAttribute('href', '/api/v1/browser-agents/extension-download')

    const installSteps = screen.getByRole('list', { name: 'Chrome installation steps' })
    expect(installSteps.children).toHaveLength(4)
    expect(installSteps).toHaveTextContent('Developer mode')
    expect(installSteps).toHaveTextContent('Load unpacked')
    expect(installSteps).toHaveTextContent('manifest.json')
    expect(screen.getByText(/version 116 or later/)).toBeInTheDocument()
  })

  it('explains how to pair and use the extension once installed', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Browser Extension')

    expect(screen.getByRole('button', { name: 'Pair & Use' })).toBeInTheDocument()

    const setupSteps = screen.getByRole('list', { name: 'Browser extension pairing steps' })
    expect(setupSteps.children).toHaveLength(4)
    expect(setupSteps).toHaveTextContent('Pair the extension')
    expect(setupSteps).toHaveTextContent('valid for 10 minutes and usable once')
    expect(setupSteps).toHaveTextContent('Capture PDF from this tab')
    expect(setupSteps).toHaveTextContent('create a new one on the spot')
    expect(setupSteps).toHaveTextContent('Retrieve missing PDFs')
    expect(screen.getByText(/immediately stops it from claiming further retrieval jobs/i)).toBeInTheDocument()
  })

  it('presents practical guidance as a scannable set of cards', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Good to Know')

    const guidance = screen.getByRole('list', { name: 'Helpful things to know' })
    expect(guidance.children).toHaveLength(12)
    expect(screen.getByRole('heading', { name: 'Small things that keep a review moving' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Upload with permission' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'You stay in control' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Claims expire automatically' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Faster with a keyboard' })).toBeInTheDocument()
    expect(guidance).toHaveTextContent('Include, Exclude, Uncertain, Duplicate and Submit each have a keyboard shortcut')
    expect(guidance).toHaveTextContent('Account Settings → Screening Hotkeys')
    expect(screen.getByRole('heading', { name: 'The latest decision guides what happens next' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Import a collection or add one record' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Attach full text wherever it fits' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'See patterns across every review stage' })).toBeInTheDocument()
    expect(guidance).toHaveTextContent('CSV, TSV, XLSX, RIS, or BibTeX')
    expect(guidance).toHaveTextContent('bulk-match them across Publications')
    expect(guidance).toHaveTextContent('extraction completeness and distributions')
    expect(guidance).toHaveTextContent('Late inclusions receive any missing downstream work')
  })

  it('numbers all six review stages in order with their colors', () => {
    renderWithProviders(<HelpPage />)

    const timeline = screen.getByRole('list', { name: 'Review stages' })
    const items = Array.from(timeline.children)
    expect(items).toHaveLength(6)
    expect(items[0]).toHaveTextContent('1')
    expect(items[0]).toHaveTextContent('Draft')
    expect(items[5]).toHaveTextContent('6')
    expect(items[5]).toHaveTextContent('Completed')
  })

  it('styles reviewer and project owner guidance as matching stage timelines', () => {
    renderWithProviders(<HelpPage />)
    goToTab('Roles & Responsibilities')

    for (const label of ['Reviewer responsibilities by stage', 'Project owner responsibilities by stage']) {
      const timeline = screen.getByRole('list', { name: label })
      const items = Array.from(timeline.children)

      expect(timeline).toHaveAttribute('data-timeline', 'responsibilities')
      expect(items).toHaveLength(6)
      expect(items[0].firstElementChild).toHaveTextContent('1')
      expect(items[0]).toHaveStyle({ '--stage-color': '#2a78d6' })
      expect(items[5].firstElementChild).toHaveTextContent('6')
      expect(items[5]).toHaveStyle({ '--stage-color': '#008300' })
    }
  })
})
