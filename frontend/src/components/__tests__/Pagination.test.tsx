import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TABLE_PAGE_SIZE, PaginationControls, PaginationSummary } from '../Pagination'

const TABLE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200]

describe('PaginationSummary', () => {
  it('renders nothing when there are no rows', () => {
    const { container } = render(
      <PaginationSummary noun="publication" page={1} pageSize={25} itemCount={0} total={0} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reports the current slice on a full middle page', () => {
    render(<PaginationSummary noun="publication" page={2} pageSize={25} itemCount={25} total={240} />)
    expect(screen.getByRole('status')).toHaveTextContent('Showing 26–50 of 240 publications')
  })

  it('clamps the end to the total on a short last page', () => {
    render(<PaginationSummary noun="job" page={3} pageSize={25} itemCount={7} total={57} />)
    expect(screen.getByRole('status')).toHaveTextContent('Showing 51–57 of 57 jobs')
  })

  it('uses the singular noun for a lone row', () => {
    render(<PaginationSummary noun="conflict" page={1} pageSize={25} itemCount={1} total={1} />)
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1–1 of 1 conflict')
  })
})

describe('PaginationControls', () => {
  const setup = (overrides: Partial<Parameters<typeof PaginationControls>[0]> = {}) => {
    const onPageChange = vi.fn()
    const onPageSizeChange = vi.fn()
    render(
      <PaginationControls
        label="Widget pages"
        page={2}
        pageCount={5}
        pageSize={DEFAULT_TABLE_PAGE_SIZE}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        {...overrides}
      />,
    )
    return { onPageChange, onPageSizeChange }
  }

  it('hides page navigation when there is only one page but keeps the size selector', () => {
    setup({ pageCount: 1 })
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Go to page')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Rows per page')).toBeInTheDocument()
  })

  it('steps to the previous and next page', () => {
    const { onPageChange } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onPageChange).toHaveBeenNthCalledWith(1, 3)
    expect(onPageChange).toHaveBeenNthCalledWith(2, 1)
  })

  it('disables Previous on the first page and Next on the last', () => {
    const { rerender } = renderControls({ page: 1 })
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    rerender({ page: 5 })
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('jumps to a typed page', () => {
    const { onPageChange } = setup()
    fireEvent.change(screen.getByLabelText('Go to page'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onPageChange).toHaveBeenCalledWith(4)
  })

  it('clamps an out-of-range go-to-page value to the last page', () => {
    const { onPageChange } = setup()
    fireEvent.change(screen.getByLabelText('Go to page'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onPageChange).toHaveBeenCalledWith(5)
  })

  it('ignores a go-to-page submit that would not move', () => {
    const { onPageChange } = setup({ page: 3 })
    const field = screen.getByLabelText('Go to page')
    fireEvent.change(field, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onPageChange).not.toHaveBeenCalled()
  })

  it('reports a page-size change as a number', () => {
    const { onPageSizeChange } = setup()
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '100' } })
    expect(onPageSizeChange).toHaveBeenCalledWith(100)
  })

  it('offers the shared option set plus any non-standard current size', () => {
    setup({ pageSize: 30 })
    const options = Array.from(
      screen.getByLabelText('Rows per page').querySelectorAll('option'),
      (option) => Number(option.value),
    )
    expect(options).toEqual([...TABLE_PAGE_SIZE_OPTIONS, 30].sort((a, b) => a - b))
  })
})

function renderControls(overrides: Partial<Parameters<typeof PaginationControls>[0]>) {
  const props = {
    label: 'Widget pages',
    page: 2,
    pageCount: 5,
    pageSize: DEFAULT_TABLE_PAGE_SIZE,
    onPageChange: vi.fn(),
    onPageSizeChange: vi.fn(),
    ...overrides,
  }
  const view = render(<PaginationControls {...props} />)
  return {
    rerender: (next: Partial<Parameters<typeof PaginationControls>[0]>) =>
      view.rerender(<PaginationControls {...props} {...next} />),
  }
}
