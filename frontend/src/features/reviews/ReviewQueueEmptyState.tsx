import { useNavigate } from 'react-router-dom'

/**
 * "No item is open" state shared by the extraction and quality workspaces: loading, a completed
 * message with a way back to the project, or a load error. The wording is domain-specific and
 * supplied by the caller.
 */
export function ReviewQueueEmptyState({
  projectId,
  loadingNext,
  loadingMessage,
  queueEmpty,
  completedMessage,
  nextError,
}: {
  projectId: string
  loadingNext: boolean
  loadingMessage: string
  queueEmpty: boolean
  completedMessage: string
  nextError: string | null
}) {
  const navigate = useNavigate()
  return (
    <>
      {loadingNext ? <p>{loadingMessage}</p> : null}
      {!loadingNext && queueEmpty ? (
        <>
          <p>{completedMessage}</p>
          <button type="button" className="button-secondary" onClick={() => navigate(`/projects/${projectId}`)}>
            Back to project
          </button>
        </>
      ) : null}
      {!loadingNext && nextError ? (
        <p className="error" role="alert">{nextError}</p>
      ) : null}
    </>
  )
}
