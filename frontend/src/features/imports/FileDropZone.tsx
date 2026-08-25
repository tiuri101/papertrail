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
    <div className="dropzone-field grid gap-2 has-[input:focus-visible]:[&_[data-dropzone]]:outline-3 has-[input:focus-visible]:[&_[data-dropzone]]:outline-offset-2 has-[input:focus-visible]:[&_[data-dropzone]]:outline-focus">
      <FieldLabel htmlFor={id}>
        {label}
        <input
          ref={inputRef}
          id={id}
          className="sr-only"
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
        className={`dropzone grid justify-items-center gap-1 min-h-[92px] rounded-md border-2 border-dashed border-border-strong bg-bg-elevated p-4 text-center text-[0.88rem] text-text-secondary cursor-pointer transition-[border-color,background-color,color] duration-150 ease-linear hover:border-primary hover:bg-surface-hover hover:text-text${dragging ? ' border-primary bg-primary-container text-primary' : ''}`}
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
          <span className="dropzone__browse font-[640] text-primary">Click to browse</span>
          {' '}or drag and drop {multiple ? 'files' : 'a file'} here
        </p>
        {hint ? <p className="text-text dropzone__hint text-[0.78rem]">{hint}</p> : null}
      </div>
      {files.length ? (
        <ul className="file-list grid grid-cols-[minmax(0,1fr)] gap-2 m-0 p-0 list-none">
          {files.map((file, index) => (
            <li key={fileKey(file)} className="file-chip flex items-center gap-3 min-w-0 rounded-sm border border-border bg-surface px-3 py-2">
              <span className="file-chip__name flex-1 min-w-0 overflow-hidden text-text font-[620] text-[0.88rem] text-ellipsis whitespace-nowrap">{file.name}</span>
              <span className="file-chip__size text-text flex-none text-[0.78rem]">{formatFileSize(file.size)}</span>
              <button
                type="button"
                className="file-chip__remove flex-none w-[26px] min-w-[26px] h-[26px] min-h-[26px] rounded-full border-0 bg-transparent p-0 text-text-muted shadow-none hover:not-disabled:bg-danger-container hover:not-disabled:text-danger hover:not-disabled:shadow-none hover:not-disabled:scale-100"
                aria-label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() => onChange(files.filter((_, i) => i !== index))}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" className="w-[14px] h-[14px] fill-current">
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
