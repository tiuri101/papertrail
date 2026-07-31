import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { DynamicForm, type DynamicFormField } from '../DynamicForm'

function Harness({ fields, initial = {} }: { fields: DynamicFormField[]; initial?: Record<string, unknown> }) {
  const [value, setValue] = useState<Record<string, unknown>>(initial)
  return (
    <>
      <DynamicForm
        fields={fields}
        value={value}
        onChange={(key, next) => setValue((current) => ({ ...current, [key]: next }))}
      />
      <pre data-testid="value">{JSON.stringify(value)}</pre>
    </>
  )
}

describe('DynamicForm', () => {
  it('renders a short_text field and reports typed input', () => {
    render(<Harness fields={[{ stableKey: 'title', label: 'Title', fieldType: 'short_text', required: true, options: [] }]} />)
    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'Hello' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"title":"Hello"}')
  })

  it('renders a long_text field as a textarea', () => {
    render(<Harness fields={[{ stableKey: 'notes', label: 'Notes', fieldType: 'long_text', required: false, options: [] }]} />)
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Some notes' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"notes":"Some notes"}')
  })

  it('renders a number field and reports a numeric value', () => {
    render(<Harness fields={[{ stableKey: 'count', label: 'Count', fieldType: 'number', required: false, options: [] }]} />)
    fireEvent.change(screen.getByLabelText('Count'), { target: { value: '12' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"count":12}')
  })

  it('renders a checkbox field', () => {
    render(<Harness fields={[{ stableKey: 'peer_reviewed', label: 'Peer reviewed', fieldType: 'checkbox', required: false, options: [] }]} />)
    fireEvent.click(screen.getByLabelText('Peer reviewed'))
    expect(screen.getByTestId('value')).toHaveTextContent('{"peer_reviewed":true}')
  })

  it('renders a single_select field with the configured options', () => {
    render(<Harness fields={[{ stableKey: 'design', label: 'Design', fieldType: 'single_select', required: true, options: ['Strong', 'Weak'] }]} />)
    expect(screen.getByRole('option', { name: 'Strong' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Design *'), { target: { value: 'Weak' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"design":"Weak"}')
  })

  it('renders a multiple_select field as a checkbox group', () => {
    render(<Harness fields={[{ stableKey: 'topics', label: 'Topics', fieldType: 'multiple_select', required: false, options: ['A', 'B'] }]} />)
    fireEvent.click(screen.getByLabelText('A'))
    fireEvent.click(screen.getByLabelText('B'))
    expect(screen.getByTestId('value')).toHaveTextContent('{"topics":["A","B"]}')
  })

  it('renders date and url fields with the matching input type', () => {
    render(<Harness fields={[
      { stableKey: 'published', label: 'Published', fieldType: 'date', required: false, options: [] },
      { stableKey: 'link', label: 'Link', fieldType: 'url', required: false, options: [] },
    ]} />)
    expect(screen.getByLabelText('Published')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Link')).toHaveAttribute('type', 'url')
  })

  it('renders a rating field with options 1 through 5 by default', () => {
    render(<Harness fields={[{ stableKey: 'score', label: 'Score', fieldType: 'rating', required: false, options: [] }]} />)
    fireEvent.change(screen.getByLabelText('Score'), { target: { value: '4' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"score":4}')
  })

  it('renders a rating field with a configured scale', () => {
    render(<Harness fields={[{ stableKey: 'score', label: 'Score', fieldType: 'rating', required: false, options: ['0', '10'] }]} />)
    expect(screen.getByRole('option', { name: '0' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '10' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '11' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Score'), { target: { value: '7' } })
    expect(screen.getByTestId('value')).toHaveTextContent('{"score":7}')
  })

  it('pre-fills fields from the initial value', () => {
    render(<Harness
      fields={[{ stableKey: 'title', label: 'Title', fieldType: 'short_text', required: false, options: [] }]}
      initial={{ title: 'Existing draft' }}
    />)
    expect(screen.getByLabelText('Title')).toHaveValue('Existing draft')
  })
})
