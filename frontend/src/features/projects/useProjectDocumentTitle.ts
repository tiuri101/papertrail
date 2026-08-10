import { useEffect } from 'react'

const DEFAULT_DOCUMENT_TITLE = 'Papertrail'

export function useProjectDocumentTitle(projectName: string | undefined) {
  useEffect(() => {
    if (!projectName) return undefined

    document.title = `${projectName} · ${DEFAULT_DOCUMENT_TITLE}`
    return () => {
      document.title = DEFAULT_DOCUMENT_TITLE
    }
  }, [projectName])
}
