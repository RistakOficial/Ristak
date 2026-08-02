import assert from 'node:assert/strict'
import test from 'node:test'

import { getTableLoadingIndicators } from '../src/components/common/Table/loadingIndicators.ts'
import { getTablePaginationItems } from '../src/components/common/Table/pagination.ts'

test('muestra un solo indicador dentro del buscador durante una búsqueda remota', () => {
  assert.deepEqual(
    getTableLoadingIndicators({
      isRefreshing: true,
      hasSearchControl: true,
      hasSearchTerm: true
    }),
    { search: true, standalone: false }
  )
})

test('conserva el indicador general para actualizaciones sin búsqueda activa', () => {
  assert.deepEqual(
    getTableLoadingIndicators({
      isRefreshing: true,
      hasSearchControl: true,
      hasSearchTerm: false
    }),
    { search: false, standalone: true }
  )

  assert.deepEqual(
    getTableLoadingIndicators({
      isRefreshing: true,
      hasSearchControl: false,
      hasSearchTerm: false
    }),
    { search: false, standalone: true }
  )
})

test('oculta ambos indicadores cuando la tabla no se está actualizando', () => {
  assert.deepEqual(
    getTableLoadingIndicators({
      isRefreshing: false,
      hasSearchControl: true,
      hasSearchTerm: true
    }),
    { search: false, standalone: false }
  )
})

test('muestra todas las paginas cuando caben en la ventana', () => {
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 1, totalPages: 4 }),
    [1, 2, 3, 4]
  )
})

test('mueve una ventana de cinco paginas y marca los extremos ocultos', () => {
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 1, totalPages: 20 }),
    [1, 2, 3, 4, 5, 'next-ellipsis']
  )
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 3, totalPages: 20 }),
    ['previous-ellipsis', 2, 3, 4, 5, 6, 'next-ellipsis']
  )
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 20, totalPages: 20 }),
    ['previous-ellipsis', 16, 17, 18, 19, 20]
  )
})

test('previsualiza cinco pasos sin abandonar la paginacion por cursor', () => {
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 1, cursorPagination: true, hasNextPage: true }),
    [1, 2, 3, 4, 5, 'next-ellipsis']
  )
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 4, cursorPagination: true, hasNextPage: true }),
    ['previous-ellipsis', 3, 4, 5, 6, 7, 'next-ellipsis']
  )
  assert.deepEqual(
    getTablePaginationItems({ currentPage: 7, cursorPagination: true, hasNextPage: false }),
    ['previous-ellipsis', 3, 4, 5, 6, 7]
  )
})
