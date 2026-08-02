export const TABLE_PAGINATION_WINDOW_SIZE = 5

export type TablePaginationItem = number | 'previous-ellipsis' | 'next-ellipsis'

interface TablePaginationItemsOptions {
  currentPage: number
  totalPages?: number
  cursorPagination?: boolean
  hasNextPage?: boolean
  windowSize?: number
}

function createPageRange(startPage: number, endPage: number): number[] {
  return Array.from(
    { length: Math.max(endPage - startPage + 1, 0) },
    (_, index) => startPage + index
  )
}

export function getTablePaginationItems({
  currentPage,
  totalPages = 1,
  cursorPagination = false,
  hasNextPage = false,
  windowSize = TABLE_PAGINATION_WINDOW_SIZE
}: TablePaginationItemsOptions): TablePaginationItem[] {
  const safeWindowSize = Math.max(Math.floor(windowSize), 1)
  const safeCurrentPage = Math.max(Math.floor(currentPage) || 1, 1)

  if (cursorPagination) {
    const startPage = hasNextPage
      ? Math.max(safeCurrentPage - 1, 1)
      : Math.max(safeCurrentPage - safeWindowSize + 1, 1)
    const endPage = hasNextPage
      ? startPage + safeWindowSize - 1
      : safeCurrentPage
    const items: TablePaginationItem[] = createPageRange(startPage, endPage)

    if (startPage > 1) items.unshift('previous-ellipsis')
    if (hasNextPage) items.push('next-ellipsis')

    return items
  }

  const safeTotalPages = Math.max(Math.floor(totalPages) || 1, 1)
  const clampedCurrentPage = Math.min(safeCurrentPage, safeTotalPages)
  const visiblePageCount = Math.min(safeWindowSize, safeTotalPages)
  const lastStartPage = Math.max(safeTotalPages - visiblePageCount + 1, 1)
  const startPage = Math.min(Math.max(clampedCurrentPage - 1, 1), lastStartPage)
  const endPage = startPage + visiblePageCount - 1
  const items: TablePaginationItem[] = createPageRange(startPage, endPage)

  if (startPage > 1) items.unshift('previous-ellipsis')
  if (endPage < safeTotalPages) items.push('next-ellipsis')

  return items
}
