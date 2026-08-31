# Browser Helper

Papertrail's optional **Browser Helper** is a Chrome Manifest V3 extension used to retrieve publisher PDFs through a reviewer's own browser network access and sign-in state. This is useful when the Papertrail server is outside an institutional network but the reviewer's computer can access subscription content.

The extension never sends Papertrail publisher cookies, institutional passwords, or captured publisher authorization headers. It receives one publication at a time, retrieves a candidate PDF in Chrome, and uploads the resulting file to Papertrail, where the backend validates it again through the normal full-text PDF pipeline.

## Install a released extension

The backend Docker image bakes in a matching build of `browser-extension/`, so the easiest way to
get the ZIP is straight from a running Papertrail server: sign in, open **Account Settings →
Browser Helpers**, and choose **Download Browser Helper (.zip)** (also linked from the **Help →
Browser Extension** page). That endpoint (`GET /api/v1/browser-agents/extension-download`)
requires a signed-in session and 404s on a source/dev backend, which has no bundled ZIP.

The CI release workflow also attaches the same build, named like:

```text
papertrail-browser-extension-2026.08.01.zip
```

to the matching GitHub release, for anyone without a running server yet.

To install it in Chrome:

1. Download the Browser Helper ZIP that matches the Papertrail release you are running.
2. Extract the ZIP to a permanent local directory. Do not load the ZIP file itself.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Choose **Load unpacked**.
6. Select the extracted directory containing `manifest.json`.
7. Pin **Papertrail Browser Helper** to the Chrome toolbar if desired.

Chrome does not automatically update unpacked extensions. When Papertrail is upgraded, download the Browser Helper from the corresponding release, replace the extracted files, and use **Reload** on `chrome://extensions`.

For development builds, use `npm run build` or `npm run dev` in `browser-extension/` and load `browser-extension/dist` instead. See [Local development](local-development.md).

## Pair the extension

1. Sign in to Papertrail.
2. Open **Account Settings → Browser Helpers**.
3. Choose **Pair new browser helper**.
4. Copy the one-time pairing secret. The default lifetime is 10 minutes (`PAPERTRAIL_BROWSER_AGENT_PAIRING_TTL_MINUTES`).
5. Open the Browser Helper and choose **Set up**.
6. Enter the Papertrail server URL, pairing secret, and a device name.
7. Choose **Pair** and approve Chrome's request to access the Papertrail server origin.

The extension exchanges the one-time secret for its own opaque bearer token. The raw bearer token is returned once and stored by the extension; Papertrail stores only its hash. That token is accepted only by the `/api/v1/browser-agent/...` API and does not replace the normal browser session/CSRF authentication used by the web application.

You can revoke a paired helper from Account Settings. Revocation immediately prevents that token from claiming or completing further retrieval jobs. Disabling an account, an administrator password reset, or an emailed password reset also revokes that user's Browser Helpers.

## How retrieval jobs are created

There are two ways a retrieval job can enter the Browser Helper queue.

### Automatic queueing after title/abstract inclusion

When a title/abstract final decision becomes **Include**, Papertrail attempts to queue that publication for browser retrieval if it still lacks an active PDF and an eligible paired helper is available for the project workflow. This avoids requiring a separate batch action for every newly included publication.

An automatically queued retrieval attempt does **not** make a screening decision and does not mark a failed publication as unavailable or inaccessible.

### Manual batch queueing

On the project's Full-Text page, an eligible full-text reviewer, project owner, or administrator can choose **Retrieve missing PDFs**. Papertrail creates a persistent retrieval batch for the currently missing publications. The Browser Helper shows the pending count on its toolbar badge.

The badge check is read-only; it does not claim or retrieve anything. Open the extension and choose **Start** to process queued jobs.

## Retrieval flow

For each claimed job the extension receives only the information needed to locate the publication, including its identifier, title, DOI/publisher URL, upload byte limit, and lease expiry.

The extension then:

1. opens/resolves the publication's publisher location;
2. uses its resolver logic to find a likely PDF;
3. fetches it using the browser's normal access context;
4. rejects obviously invalid/non-PDF responses locally;
5. uploads the file to the claimed Papertrail retrieval job.

The API derives the target publication from the server-side claim. The extension cannot use that upload endpoint to attach an arbitrary publication ID.

On upload, FastAPI performs its own file-size and PDF validation and attaches the document with source `browser_retrieval`. A successful upload advances the authoritative full-text retrieval record to **Available** and allows normal full-text screening to proceed.

## Failures and retries

Browser retrieval jobs can require attention because of publisher authentication, access denial, an unresolved PDF URL, invalid content, network failure, or another retrieval error.

A failed automated attempt is deliberately separate from the human full-text retrieval status. It does not prove that a reviewer cannot obtain the paper manually. You can:

- sign in to the publisher in Chrome and retry;
- connect to the required university/VPN network and retry;
- upload the PDF manually;
- obtain it through another authorized source or interlibrary loan;
- set the human retrieval status manually when appropriate.

Retrieval claims use a short lease (`PAPERTRAIL_BROWSER_RETRIEVAL_LEASE_SECONDS`, 300 seconds by default). An interrupted/expired claim can become available for another attempt.

## Permissions

Pairing and revocation belong to the signed-in account. Project retrieval batches require full-text-reviewer access; project owners and installation administrators are also accepted. PDFs themselves remain protected project data and are streamed only after normal project authorization.

## API summary

User/session endpoints:

- `POST /api/v1/browser-agents/pairing-secrets`
- `GET /api/v1/browser-agents`
- `GET /api/v1/browser-agents/extension-download` (the ZIP baked into the backend Docker image; 404 if absent)
- `DELETE /api/v1/browser-agents/{agent_id}`
- `POST /api/v1/browser-agents/pair` (consumes the one-time secret; no existing session required)

Agent-token endpoints:

- `GET /api/v1/browser-agent/me`
- `GET /api/v1/browser-agent/retrieval-jobs/pending-count`
- `POST /api/v1/browser-agent/retrieval-jobs/claim`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/state`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/upload`
- `POST /api/v1/browser-agent/retrieval-jobs/{job_id}/retry`

Project batch endpoints are under `/api/v1/projects/{project_id}/pdf-retrieval-batches...`. For the complete current request/response schema, use FastAPI's `/docs` or `/openapi.json`.
