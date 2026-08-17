import { useState } from 'react'

import { ConfirmButton } from '../../components/ConfirmButton'
import { IconCopy, IconPlus, IconTrash } from '../../components/icons'
import type { PairingSecret } from './useBrowserAgents'
import { useBrowserAgents } from './useBrowserAgents'

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

export function BrowserHelpersSection() {
  const { agents, createPairingSecret, revoke } = useBrowserAgents()
  const [pairingSecret, setPairingSecret] = useState<PairingSecret | null>(null)
  const [copied, setCopied] = useState(false)

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
    <section className="card">
      <h2>Browser Helpers</h2>
      <p className="muted">
        A paired Chrome extension can retrieve publisher PDFs using this computer&apos;s own
        network connection and browser sign-in (e.g. university IP access, VPN, or an
        institutional login already open in Chrome). Papertrail never receives your publisher
        credentials or browser cookies, only the resulting PDF.
      </p>
      {agents.error ? <p className="error" role="alert">{agents.error.message}</p> : null}
      {agents.isLoading ? <p className="muted">Loading browser helpers…</p> : null}
      {agents.data && agents.data.length > 0 ? (
        <ul className="compact-list">
          {agents.data.map((agent) => (
            <li key={agent.id}>
              <strong>{agent.displayName}</strong>
              {' · '}
              <span className="muted">
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
        <p className="muted">No browser helper is paired with your account.</p>
      ) : null}
      {revoke.error ? <p className="error" role="alert">{revoke.error.message}</p> : null}

      {pairingSecret ? (
        <div className="card" role="region" aria-label="Pairing secret">
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
          <p className="muted">
            Expires: {formatDateTime(pairingSecret.expiresAt)}. This secret is shown only once --
            paste it into the Chrome extension&apos;s setup page now.
          </p>
          <div className="toolbar">
            <button type="button" onClick={handleCopy}>
              <IconCopy />
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="button-secondary" onClick={() => setPairingSecret(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          {createPairingSecret.error ? (
            <p className="error" role="alert">{createPairingSecret.error.message}</p>
          ) : null}
          <button type="button" onClick={handleCreatePairingSecret} disabled={createPairingSecret.isPending}>
            <IconPlus />
            Pair new browser helper
          </button>
        </>
      )}
    </section>
  )
}
