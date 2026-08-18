import { PapertrailAuthError, type PapertrailClient } from '../papertrail/client'
import type { ClaimedJob } from '../papertrail/types'
import type { EngineEvent, EngineJobOutcome } from './engine'
import { RetrievalEngine } from './engine'
import { requestOriginPermission } from './permission-manager'

export interface RetrievalCounters {
  retrieved: number
  attention: number
}

export interface RetrievalSnapshot {
  running: boolean
  counters: RetrievalCounters
  currentJob: ClaimedJob | null
  statusText: string
  pendingPermissionOrigin: string | null
  lastOutcomeMessage: string | null
  authError: string | null
}

/**
 * Drives one job at a time through the RetrievalEngine. Runs inside a
 * normal extension page (not the MV3 service worker) so a long-running
 * batch survives independently of service-worker lifetime; see engine.ts
 * for the actual publisher-facing retrieval logic.
 */
export class RetrievalSession {
  private running = false
  private counters: RetrievalCounters = { retrieved: 0, attention: 0 }
  private currentJob: ClaimedJob | null = null
  private statusText = 'Idle'
  private pendingPermissionOrigin: string | null = null
  private lastOutcomeMessage: string | null = null
  private authError: string | null = null

  constructor(
    private readonly client: PapertrailClient,
    private readonly onChange: (snapshot: RetrievalSnapshot) => void,
    private readonly createEngine: (
      client: PapertrailClient,
      onEvent: (event: EngineEvent) => void,
    ) => RetrievalEngine = (c, onEvent) => new RetrievalEngine(c, onEvent),
  ) {}

  get snapshot(): RetrievalSnapshot {
    return {
      running: this.running,
      counters: { ...this.counters },
      currentJob: this.currentJob,
      statusText: this.statusText,
      pendingPermissionOrigin: this.pendingPermissionOrigin,
      lastOutcomeMessage: this.lastOutcomeMessage,
      authError: this.authError,
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.pendingPermissionOrigin = null
    this.authError = null
    this.emit()
    void this.loop()
  }

  pause(): void {
    this.running = false
    this.statusText = 'Paused'
    this.emit()
  }

  async grantPermissionAndResume(): Promise<void> {
    const origin = this.pendingPermissionOrigin
    if (!origin) return
    const granted = await requestOriginPermission(origin)
    if (granted) {
      this.pendingPermissionOrigin = null
      this.running = true
      this.emit()
      void this.loop()
      return
    }
    this.emit()
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let job: ClaimedJob | null
      try {
        job = await this.client.claimJob()
      } catch (error) {
        this.running = false
        if (error instanceof PapertrailAuthError) {
          this.authError = error.message
          this.statusText = error.message
        } else {
          this.statusText = 'Could not reach Papertrail. Retry from the extension popup.'
        }
        this.emit()
        return
      }

      if (!job) {
        this.running = false
        this.currentJob = null
        this.statusText = 'No retrieval jobs are currently queued.'
        this.emit()
        return
      }

      this.currentJob = job
      this.statusText = 'Starting...'
      this.emit()

      const engine = this.createEngine(this.client, (event) => {
        this.statusText = PHASE_LABELS[event.phase]
        this.emit()
      })
      const outcome = await engine.processJob(job)
      this.applyOutcome(job, outcome)
      this.emit()
    }
  }

  private applyOutcome(job: ClaimedJob, outcome: EngineJobOutcome): void {
    if (outcome.status === 'no_permission') {
      this.running = false
      this.pendingPermissionOrigin = outcome.origin
      this.statusText = 'Papertrail needs permission to visit publisher websites'
      return
    }
    if (outcome.status === 'succeeded') {
      this.counters.retrieved += 1
      this.lastOutcomeMessage = `Retrieved: ${job.publication.title}`
      return
    }
    this.counters.attention += 1
    this.lastOutcomeMessage = `${outcome.status.replace(/_/g, ' ')}: ${job.publication.title}`
  }

  private emit(): void {
    this.onChange(this.snapshot)
  }
}

const PHASE_LABELS: Record<EngineEvent['phase'], string> = {
  'resolving-start-url': 'Resolving publisher URL…',
  'fetching-landing-page': 'Opening publisher page…',
  'discovering-pdf-links': 'Looking for a PDF link…',
  'downloading-pdf': 'Downloading PDF…',
  'validating-pdf': 'Validating PDF…',
  uploading: 'Uploading to Papertrail…',
}
