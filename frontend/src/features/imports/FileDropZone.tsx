import { useRef, useState } from 'react'

import { formatFileSize } from '../../lib/format'
import { FieldLabel } from '../../components/FieldLabel'

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function mergeFiles(existing: File[], incoming: File[], multiple: boolean): File[] {
  if (!multiple) return incoming.slice(0, 1)
  const seen = new Set(existing.map(fileKey))
  const merged = [...existing]
  for (const file of incoming) {
    const key = fileKey(file)
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(file)
    }
  }
  return merged
}

interface FileDropZoneProps {
  id: string
  label: string
  hint?: string
  accept?: string
  multiple?: boolean
  files: File[]
  onChange: (files: File[]) => void
  disabled?: boolean
}

export function FileDropZone({
  id,
  label,
  hint,
  accept,
  multiple = false,
  files,
  onChange,
  disabled,
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const addFiles = (incoming: FileList | File[] | null | undefined) => {
    if (!incoming || disabled) return
    const next = Array.from(incoming)
    if (next.length === 0) return
    onChange(mergeFiles(files, next, multiple))
  }

  return (
    <div className="dropzone-field">
      <FieldLabel htmlFor={id}>
        {label}
        <input
          ref={inputRef}
          id={id}
          className="visually-hidden"
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          onChange={(event) => {
            addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </FieldLabel>
      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        data-dropzone
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          addFiles(event.dataTransfer.files)
        }}
      >
        <p>
          <span className="dropzone__browse">Click to browse</span>
          {' '}or drag and drop {multiple ? 'files' : 'a file'} here
        </p>
        {hint ? <p className="muted dropzone__hint">{hint}</p> : null}
      </div>
      {files.length ? (
        <ul className="file-list">
          {files.map((file, index) => (
            <li key={fileKey(file)} className="file-chip">
              <span className="file-chip__name">{file.name}</span>
              <span className="file-chip__size muted">{formatFileSize(file.size)}</span>
              <button
                type="button"
                className="file-chip__remove"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
