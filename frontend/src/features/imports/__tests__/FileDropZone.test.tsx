import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { FileDropZone } from '../FileDropZone'

function ControlledDropZone({ multiple }: { multiple?: boolean }) {
  const [files, setFiles] = useState<File[]>([])
  return (
    <FileDropZone
      id="test-files"
      label="Test files"
      multiple={multiple}
      files={files}
      onChange={setFiles}
    />
  )
}

describe('FileDropZone', () => {
  it('lists a selected file and removes it on click', () => {
    render(<ControlledDropZone multiple />)

    const file = new File(['content'], 'records.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Test files'), { target: { files: [file] } })

    expect(screen.getByText('records.csv')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove records.csv' }))

    expect(screen.queryByText('records.csv')).not.toBeInTheDocument()
  })

  it('adds files dropped onto the dropzone', () => {
    render(<ControlledDropZone multiple />)

    const file = new File(['content'], 'dropped.pdf', { type: 'application/pdf' })
    const dropzone = screen.getByText(/drag and drop/).closest('[data-dropzone]') as HTMLElement

    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })

    expect(screen.getByText('dropped.pdf')).toBeInTheDocument()
  })

  it('accumulates multiple selections when multiple is set', () => {
    render(<ControlledDropZone multiple />)

    const input = screen.getByLabelText('Test files')
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.pdf', { type: 'application/pdf' })] } })
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.pdf', { type: 'application/pdf' })] } })

    expect(screen.getByText('a.pdf')).toBeInTheDocument()
    expect(screen.getByText('b.pdf')).toBeInTheDocument()
  })

  it('replaces the current file for single-file fields', () => {
    render(<ControlledDropZone />)

    const input = screen.getByLabelText('Test files')
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' })] } })
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.csv', { type: 'text/csv' })] } })

    expect(screen.queryByText('a.csv')).not.toBeInTheDocument()
    expect(screen.getByText('b.csv')).toBeInTheDocument()
  })
})
