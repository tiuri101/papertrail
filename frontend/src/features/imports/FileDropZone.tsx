import { useRef, useState } from 'react'

import { cn } from '../../lib/cn'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}

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
    <div className="grid gap-2 has-[input:focus-visible]:[&_[data-dropzone]]:outline-3 has-[input:focus-visible]:[&_[data-dropzone]]:outline-offset-2 has-[input:focus-visible]:[&_[data-dropzone]]:outline-focus">
      <label htmlFor={id}>
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
      </label>
      <div
        className={cn(
          'grid min-h-[92px] cursor-pointer justify-items-center gap-1 rounded-md border-2 border-dashed border-border-strong bg-bg-elevated p-4 text-center text-[0.88rem] text-text-secondary transition-[border-color,background-color,color] duration-150 hover:border-primary hover:bg-surface-hover hover:text-text',
          dragging && 'border-primary bg-primary-container text-primary',
        )}
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
          <span className="font-semibold text-primary">Click to browse</span>
          {' '}or drag and drop {multiple ? 'files' : 'a file'} here
        </p>
        {hint ? <p className="text-[0.78rem] text-text-muted">{hint}</p> : null}
      </div>
      {files.length ? (
        <ul className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-2 p-0">
          {files.map((file, index) => (
            <li key={fileKey(file)} className="flex min-w-0 items-center gap-3 rounded-sm border border-border bg-surface px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[0.88rem] font-semibold text-text">{file.name}</span>
              <span className="shrink-0 text-[0.78rem] text-text-muted">{formatFileSize(file.size)}</span>
              <button
                type="button"
                className="inline-flex size-[26px] min-h-[26px] min-w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-none p-0 text-text-muted shadow-none hover:bg-danger-container hover:text-danger disabled:cursor-not-allowed disabled:opacity-[.48] [&_svg]:size-3.5 [&_svg]:fill-current"
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
