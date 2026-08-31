import { useState } from 'react'

import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconCopy, IconDownload, IconPlus, IconTrash, IconUpload } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import type { PairingSecret } from './useBrowserAgents'
import { useBrowserAgents } from './useBrowserAgents'

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

export function BrowserHelpersSection() {
  const [pairingSecret, setPairingSecret] = useState<PairingSecret | null>(null)
  const [copied, setCopied] = useState(false)
  const { agents, createPairingSecret, revoke } = useBrowserAgents(pairingSecret !== null)

  const handleCreatePairingSecret = () => {
    setCopied(false)
    createPairingSecret.mutate(undefined, {
      onSuccess: (result) => setPairingSecret(result),
    })
  }

  const handleCopy = async () => {
    if (!pairingSecret) return
    try {
      await navigator.clipboard.writeText(pairingSecret.pairingSecret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <CollapsibleSection id="section-account-browser-helpers" title="Browser Helpers" icon={<IconUpload />}>
      <p className="text-text">
        A paired Chrome extension can retrieve publisher PDFs using this computer&apos;s own
        network connection and browser sign-in (e.g. university IP access, VPN, or an
        institutional login already open in Chrome). Papertrail never receives your publisher
        credentials or browser cookies, only the resulting PDF.
      </p>
      <div className={toolbarClass}>
        <Button as="a" href="/api/v1/browser-agents/extension-download" variant="secondary">
          <IconDownload />
          Download Browser Helper (.zip)
        </Button>
      </div>
      <p className="text-text-muted text-sm">
        See the Browser Extension tab in Help for installation steps, including how to enable
        Chrome&apos;s developer mode to load it.
      </p>
      {agents.error ? <p className="text-danger" role="alert">{agents.error.message}</p> : null}
      {agents.isLoading ? <p className="text-text">Loading browser helpers…</p> : null}
      {agents.data && agents.data.length > 0 ? (
        <ul className="mb-0 list-disc pl-6">
          {agents.data.map((agent) => (
            <li key={agent.id}>
              <strong>{agent.displayName}</strong>
              {' · '}
              <span className="text-text">
                Last connected: {formatDateTime(agent.lastSeenAt)}
                {agent.extensionVersion ? ` · Extension v${agent.extensionVersion}` : ''}
              </span>
              {' '}
              <ConfirmButton
                label="Revoke"
                confirmLabel="Revoke"
                warning={`Revoke "${agent.displayName}"? It will immediately lose access.`}
                onConfirm={() => revoke.mutate(agent.id)}
                disabled={revoke.isPending}
                variant="danger"
                icon={<IconTrash />}
              />
            </li>
          ))}
        </ul>
      ) : agents.data ? (
        <p className="text-text">No browser helper is paired with your account.</p>
      ) : null}
      {revoke.error ? <p className="text-danger" role="alert">{revoke.error.message}</p> : null}

      {pairingSecret ? (
        <Card role="region" aria-label="Pairing secret">
          <p>
            Papertrail server:
            <br />
            <strong>{pairingSecret.serverUrl}</strong>
          </p>
          <p>
            Pairing secret:
            <br />
            <code>{pairingSecret.pairingSecret}</code>
          </p>
          <p className="text-text">
            Expires: {formatDateTime(pairingSecret.expiresAt)}. This secret is shown only once --
            paste it into the Chrome extension&apos;s setup page now.
          </p>
          <div className={toolbarClass}>
            <Button type="button" onClick={handleCopy}>
              <IconCopy />
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPairingSecret(null)}>
              Done
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {createPairingSecret.error ? (
            <p className="text-danger" role="alert">{createPairingSecret.error.message}</p>
          ) : null}
          <Button type="button" onClick={handleCreatePairingSecret} loading={createPairingSecret.isPending}>
            <IconPlus />
            Pair new browser helper
          </Button>
        </>
      )}
    </CollapsibleSection>
  )
}
