import React, { useState, useMemo, useEffect, useRef } from 'react'
import {
  Search,
  ChevronUp,
  ChevronDown,
  Settings,
  Check,
  GripVertical,
  X as XIcon,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import { useTableConfig } from '@/hooks'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import { TabList } from '../TabList'
import styles from './Table.module.css'

export interface Column<T> {
  key: string
  header: React.ReactNode
  render?: (value: any, item: T) => React.ReactNode
  searchValue?: (value: any, item: T) => unknown | unknown[]
  searchable?: boolean
  sortable?: boolean
  visible?: boolean
  width?: string
  fixed?: boolean // Columna que no se puede mover ni ocultar
}

interface FilterOption {
  label: string
  value: string
}

interface RowSelection<T> {
  selectedKeys: string[]
  onChange: (selectedKeys: string[]) => void
  isRowDisabled?: (item: T) => boolean
  getRowLabel?: (item: T) => string
  selectVisibleLabel?: string
}

interface IndeterminateCheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  indeterminate?: boolean
}

function IndeterminateCheckbox({
  indeterminate = false,
  ...props
}: IndeterminateCheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate
    }
  }, [indeterminate])

  return <input ref={inputRef} type="checkbox" {...props} />
}

// Sorts flat rows that encode a parent→child tree (campaign → adset → ad) via their `level`
// field and the order in which they arrive (each parent is immediately followed by its children).
// Children must stay grouped under their parent, so we rebuild the tree from that adjacency,
// sort each sibling group independently, and re-flatten. A plain global sort would scatter child
// rows away from their parent, making an expanded row's contents appear under a different row.
// Rows without nesting (flat single-level lists, non-hierarchical tables) all become roots and
// therefore sort exactly like a normal flat sort.
function sortHierarchicalRows<T extends Record<string, any>>(
  rows: T[],
  compare: (a: T, b: T) => number
): T[] {
  interface TreeNode { row: T; children: TreeNode[] }

  const roots: TreeNode[] = []
  let currentCampaign: TreeNode | null = null
  let currentAdSet: TreeNode | null = null

  rows.forEach(row => {
    const node: TreeNode = { row, children: [] }

    if (row.level === 'adset' && currentCampaign?.row.level === 'campaign') {
      currentCampaign.children.push(node)
      currentAdSet = node
    } else if (row.level === 'ad' && currentAdSet?.row.level === 'adset') {
      currentAdSet.children.push(node)
    } else {
      roots.push(node)
      currentCampaign = node
      currentAdSet = null
    }
  })

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => compare(a.row, b.row))
    nodes.forEach(node => sortNodes(node.children))
  }
  sortNodes(roots)

  const flattened: T[] = []
  const flatten = (nodes: TreeNode[]) => {
    nodes.forEach(node => {
      flattened.push(node.row)
      flatten(node.children)
    })
  }
  flatten(roots)

  return flattened
}

function enforceFixedColumnPositions<T>(columns: Column<T>[], defaultColumns: Column<T>[]) {
  const columnsByKey = new Map(columns.map(column => [column.key, column]))
  const movableColumns = columns.filter(column => !column.fixed)
  const normalizedColumns = [...movableColumns]

  defaultColumns.forEach((defaultColumn, defaultIndex) => {
    if (!defaultColumn.fixed) return

    const resolvedColumn = columnsByKey.get(defaultColumn.key) || defaultColumn
    normalizedColumns.splice(Math.min(defaultIndex, normalizedColumns.length), 0, {
      ...resolvedColumn,
      ...defaultColumn,
      visible: true
    })
  })

  return normalizedColumns
}

function getSearchValues<T extends Record<string, any>>(item: T, columns: Column<T>[]) {
  const searchableColumns = columns.filter(column => column.searchable !== false)

  if (searchableColumns.length === 0) {
    return Object.values(item)
  }

  return searchableColumns.flatMap(column => {
    const rawValue = item[column.key]
    const searchValue = column.searchValue ? column.searchValue(rawValue, item) : rawValue
    return Array.isArray(searchValue) ? searchValue : [searchValue]
  })
}

interface TableProps<T> {
  columns?: Column<T>[] // Opcional ahora
  initialColumns?: Column<T>[] // Para definir columnas por defecto
  data: T[]
  keyExtractor: (item: T) => string
  onRowClick?: (item: T) => void
  emptyMessage?: string
  loading?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  paginated?: boolean
  pageSize?: number
  filters?: FilterOption[]
  activeFilter?: string
  onFilterChange?: (filter: string) => void
  tableId?: string // ID para guardar config en rstk_config
  initialSortBy?: string // Columna para ordenar inicialmente
  initialSortOrder?: 'asc' | 'desc' // Orden inicial
  loadingVariant?: 'skeleton' | 'spinner'
  focusedRowKey?: string | null
  rowClassName?: (item: T) => string | undefined
  toolbarStart?: React.ReactNode
  selectionActions?: React.ReactNode
  searchPosition?: 'left' | 'right'
  rowSelection?: RowSelection<T>
}

export function Table<T extends Record<string, any>>({
  columns: propColumns,
  initialColumns: propInitialColumns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = 'No hay datos disponibles',
  loading = false,
  searchable = true,
  searchPlaceholder = 'Buscar...',
  paginated = true,
  pageSize = 25,
  filters,
  activeFilter = 'all',
  onFilterChange,
  tableId,
  initialSortBy,
  initialSortOrder = 'asc',
  loadingVariant = 'skeleton',
  focusedRowKey,
  rowClassName,
  toolbarStart,
  selectionActions,
  searchPosition = 'left',
  rowSelection
}: TableProps<T>) {
  // Sistema híbrido de configuración de tablas
  const [savedTableConfig, updateTableConfig] = useTableConfig(tableId || 'default')

  const [searchTerm, setSearchTerm] = useState('')
  const [sortBy, setSortBy] = useState<string | null>(initialSortBy || null)
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(initialSortOrder)
  const [currentPage, setCurrentPage] = useState(1)
  const [editMode, setEditMode] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  // Determinar columnas iniciales (propColumns o propInitialColumns)
  const initialColumns = propInitialColumns || propColumns || []

  // Recalcular columnas base cuando cambian la definición o la config guardada
  const resolvedInitialColumns = useMemo(() => {
    if (!tableId || !savedTableConfig) {
      return enforceFixedColumnPositions(initialColumns, initialColumns)
    }

    const columnsMap = new Map(initialColumns.map(col => [col.key, col]))
    const orderedColumns: Column<T>[] = []

    savedTableConfig.forEach((config: any) => {
      const col = columnsMap.get(config.id)
      if (col) {
        orderedColumns.push({
          ...col,
          visible: col.fixed ? true : config.visible
        })
      }
    })

    const insertColumnAtDefaultPosition = (col: Column<T>, defaultIndex: number) => {
      let insertAt = orderedColumns.length

      for (let i = defaultIndex - 1; i >= 0; i -= 1) {
        const previousIndex = orderedColumns.findIndex(existing => existing.key === initialColumns[i]?.key)
        if (previousIndex >= 0) {
          insertAt = previousIndex + 1
          break
        }
      }

      if (insertAt === orderedColumns.length) {
        for (let i = defaultIndex + 1; i < initialColumns.length; i += 1) {
          const nextIndex = orderedColumns.findIndex(existing => existing.key === initialColumns[i]?.key)
          if (nextIndex >= 0) {
            insertAt = nextIndex
            break
          }
        }
      }

      orderedColumns.splice(insertAt, 0, col)
    }

    initialColumns.forEach((col, defaultIndex) => {
      if (!savedTableConfig.find((c: any) => c.id === col.key)) {
        insertColumnAtDefaultPosition(col, defaultIndex)
      }
    })

    return enforceFixedColumnPositions(orderedColumns, initialColumns)
  }, [initialColumns, savedTableConfig, tableId])

  const [columns, setColumns] = useState<Column<T>[]>(resolvedInitialColumns)

  useEffect(() => {
    setColumns(resolvedInitialColumns)
  }, [resolvedInitialColumns])

  // Función para guardar config (ahora híbrida)
  const saveColumnsConfig = async (newColumns: Column<T>[]) => {
    if (!tableId) return

    const config = newColumns.map((col, index) => ({
      id: col.key,
      visible: col.visible !== false,
      order: index
    }))

    try {
      await updateTableConfig(config)
    } catch {
      // Intentionally left blank to avoid breaking flow when persistence fails
    }
  }

  const handleDragStart = (e: React.DragEvent, columnKey: string) => {
    if (!editMode) return
    setDraggedColumn(columnKey)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', columnKey)
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (!editMode || !draggedColumn) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDragEnd = () => {
    setDraggedColumn(null)
    setDragOverColumn(null)
  }

  const handleDragEnter = (e: React.DragEvent, columnKey: string | 'hidden') => {
    if (!editMode || !draggedColumn) return
    e.preventDefault()
    setDragOverColumn(columnKey)
  }

  const handleDrop = (e: React.DragEvent, targetColumnKey: string | 'hidden') => {
    if (!editMode || !draggedColumn) return
    e.preventDefault()
    e.stopPropagation()

    const newColumns = [...columns]
    const draggedIndex = newColumns.findIndex(col => col.key === draggedColumn)
    const draggedCol = newColumns[draggedIndex]

    if (draggedIndex === -1 || draggedCol?.fixed) return

    if (targetColumnKey === 'hidden') {
      // Ocultar la columna
      if (!draggedCol.fixed) {
        newColumns[draggedIndex] = { ...draggedCol, visible: false }
      }
    } else {
      const targetIndex = newColumns.findIndex(col => col.key === targetColumnKey)
      const targetCol = newColumns[targetIndex]

      if (targetIndex === -1) {
        newColumns[draggedIndex] = { ...draggedCol, visible: true }
      } else if (draggedIndex !== targetIndex && !targetCol?.fixed) {
        const [removed] = newColumns.splice(draggedIndex, 1)
        let insertIndex = targetIndex
        if (draggedIndex < targetIndex) {
          insertIndex = targetIndex - 1
        }
        newColumns.splice(insertIndex, 0, removed)
        newColumns[insertIndex] = { ...newColumns[insertIndex], visible: true }
      }
    }

    setColumns(newColumns)
    saveColumnsConfig(newColumns)

    setDraggedColumn(null)
    setDragOverColumn(null)
  }

  const toggleColumnVisibility = (columnKey: string) => {
    const targetColumn = columns.find(col => col.key === columnKey)
    if (targetColumn?.fixed) return

    const newColumns = columns.map(col =>
      col.key === columnKey ? { ...col, visible: !col.visible } : col
    )
    setColumns(newColumns)
    saveColumnsConfig(newColumns)
  }

  const visibleColumns = columns.filter(col => col.visible !== false)
  const hiddenColumns = columns.filter(col => !col.fixed && col.visible === false)
  const preparedSearchTerm = useMemo(() => prepareSearchQuery(searchTerm), [searchTerm])
  const rowSearchIndexes = useMemo(() => {
    if (!Array.isArray(data)) return []

    return data.map(item => buildSearchIndex(getSearchValues(item, columns)))
  }, [columns, data])

  const filteredData = useMemo(() => {
    if (!Array.isArray(data)) {
      // TODO: Implement proper logging service
      return []
    }

    let filtered = [...data]

    if (searchTerm) {
      filtered = filtered.filter((item, index) =>
        searchIndexIncludes(rowSearchIndexes[index] ?? buildSearchIndex(getSearchValues(item, columns)), preparedSearchTerm)
      )
    }

    if (sortBy) {
      const compare = (a: T, b: T) => {
        const aValue = a[sortBy]
        const bValue = b[sortBy]

        if (aValue === bValue) return 0

        const result = aValue > bValue ? 1 : -1
        return sortOrder === 'asc' ? result : -result
      }

      const hasHierarchy = filtered.some(item => item && (item as any).level)
      filtered = hasHierarchy ? sortHierarchicalRows(filtered, compare) : filtered.sort(compare)
    }

    return filtered
  }, [columns, data, preparedSearchTerm, rowSearchIndexes, searchTerm, sortBy, sortOrder])

  const paginatedData = useMemo(() => {
    if (!paginated) return filteredData

    const start = (currentPage - 1) * pageSize
    const end = start + pageSize
    return filteredData.slice(start, end)
  }, [filteredData, currentPage, pageSize, paginated])

  const totalPages = Math.ceil(filteredData.length / pageSize)
  const totalVisibleColumns = visibleColumns.length + (rowSelection ? 1 : 0)
  const selectedKeySet = useMemo(() => new Set(rowSelection?.selectedKeys ?? []), [rowSelection?.selectedKeys])
  const visibleSelectableRows = useMemo(() => {
    if (!rowSelection) return []
    return paginatedData.filter(item => !rowSelection.isRowDisabled?.(item))
  }, [paginatedData, rowSelection])
  const visibleSelectableKeys = useMemo(
    () => visibleSelectableRows.map(item => keyExtractor(item)),
    [keyExtractor, visibleSelectableRows]
  )
  const allVisibleRowsSelected =
    visibleSelectableKeys.length > 0 &&
    visibleSelectableKeys.every(key => selectedKeySet.has(key))
  const someVisibleRowsSelected =
    visibleSelectableKeys.some(key => selectedKeySet.has(key))
  const hasSelectionActions = Boolean(selectionActions)
  const columnEditMode = editMode && !hasSelectionActions

  const handleToggleVisibleRows = () => {
    if (!rowSelection) return

    const nextSelected = new Set(rowSelection.selectedKeys)
    if (allVisibleRowsSelected) {
      visibleSelectableKeys.forEach(key => nextSelected.delete(key))
    } else {
      visibleSelectableKeys.forEach(key => nextSelected.add(key))
    }

    rowSelection.onChange(Array.from(nextSelected))
  }

  const handleToggleRowSelection = (item: T) => {
    if (!rowSelection || rowSelection.isRowDisabled?.(item)) return

    const rowKey = keyExtractor(item)
    const nextSelected = new Set(rowSelection.selectedKeys)
    if (nextSelected.has(rowKey)) {
      nextSelected.delete(rowKey)
    } else {
      nextSelected.add(rowKey)
    }

    rowSelection.onChange(Array.from(nextSelected))
  }

  useEffect(() => {
    const safeTotalPages = Math.max(totalPages, 1)
    if (currentPage > safeTotalPages) {
      setCurrentPage(safeTotalPages)
    }
  }, [currentPage, totalPages])

  useEffect(() => {
    if (!focusedRowKey || !paginated) return

    const focusedIndex = filteredData.findIndex((item) => keyExtractor(item) === focusedRowKey)
    if (focusedIndex < 0) return

    setCurrentPage(Math.floor(focusedIndex / pageSize) + 1)
  }, [filteredData, focusedRowKey, keyExtractor, pageSize, paginated])

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortOrder('asc')
    }
  }

  useEffect(() => {
    if (hasSelectionActions && editMode) {
      setEditMode(false)
    }
  }, [editMode, hasSelectionActions])

  const searchControl = searchable ? (
    <div className={styles.searchContainer}>
      <Search size={18} className={styles.searchIcon} />
      <input
        type="text"
        className={styles.searchInput}
        placeholder={searchPlaceholder}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
      />
    </div>
  ) : null

  if (loading && loadingVariant === 'spinner') {
    return (
      <div className={styles.loadingContainer}>
        <div className={styles.spinner}></div>
        <div className={styles.loadingText}>Cargando...</div>
      </div>
    )
  }

  if (loading) {
    const skeletonColumnCount = Math.max(totalVisibleColumns, 4)
    const skeletonRows = Math.min(Math.max(pageSize, 6), 10)

    return (
      <div className={styles.container} data-ristak-table aria-busy="true" aria-live="polite" aria-label="Cargando tabla">
        <div className={styles.tableHeader}>
          <div className={styles.leftControls}>
            {searchable && <div className={`${styles.skeletonBlock} ${styles.skeletonSearch}`} />}
            {filters && <div className={`${styles.skeletonBlock} ${styles.skeletonFilters}`} />}
          </div>
          <div className={`${styles.skeletonBlock} ${styles.skeletonAction}`} />
        </div>

        <div className={styles.skeletonTableWrapper}>
          <div
            className={styles.skeletonTable}
            style={{
              '--skeleton-columns': skeletonColumnCount,
              minWidth: `${skeletonColumnCount * 120}px`
            } as React.CSSProperties}
          >
            <div className={`${styles.skeletonRow} ${styles.skeletonHeaderRow}`}>
              {Array.from({ length: skeletonColumnCount }).map((_, index) => (
                <div className={`${styles.skeletonBlock} ${styles.skeletonHeaderCell}`} key={`skeleton-heading-${index}`} />
              ))}
            </div>
            {Array.from({ length: skeletonRows }).map((_, rowIndex) => (
              <div className={styles.skeletonRow} key={`skeleton-row-${rowIndex}`}>
                {Array.from({ length: skeletonColumnCount }).map((_, cellIndex) => (
                  <div
                    className={`${styles.skeletonBlock} ${styles.skeletonCell}`}
                    key={`skeleton-cell-${rowIndex}-${cellIndex}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container} data-ristak-table>
      <div className={styles.tableHeader}>
        <div className={styles.leftControls}>
          {toolbarStart}

          {searchPosition === 'left' && searchControl}

          {filters && onFilterChange && (
            <TabList
              tabs={filters}
              activeTab={activeFilter}
              onTabChange={onFilterChange}
            />
          )}
        </div>

        <div className={styles.tableActions}>
          {searchPosition === 'right' && searchControl}

          {hasSelectionActions ? (
            <div className={styles.selectionActions}>
              {selectionActions}
            </div>
          ) : (
            <button
              className={`${styles.actionButton} ${columnEditMode ? styles.active : ''}`}
              onClick={() => setEditMode(!editMode)}
              title={columnEditMode ? "Finalizar edición" : "Editar columnas"}
            >
              {columnEditMode ? (
                <>
                  <Check size={18} />
                  <span className={styles.buttonText}>Listo</span>
                </>
              ) : (
                <>
                  <Settings size={18} />
                  <span className={styles.buttonText}>Editar</span>
                </>
              )}
            </button>
          )}

        </div>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table} data-ristak-table-element>
          <thead>
            {/* Fila de columnas ocultas en modo edición */}
            {columnEditMode && (
              <tr className={styles.hiddenColumnsRow}>
                <td
                  colSpan={totalVisibleColumns || 1}
                  className={styles.hiddenColumnsCell}
                  onDragOver={handleDragOver}
                  onDragEnter={(e) => handleDragEnter(e, 'hidden')}
                  onDrop={(e) => handleDrop(e, 'hidden')}
                >
                  <div className={`${styles.hiddenColumnsContainer} ${dragOverColumn === 'hidden' && draggedColumn ? styles.dragOver : ''}`}>
                    <span className={styles.hiddenColumnsLabel}>
                      Columnas ocultas:
                    </span>
                    <div className={styles.hiddenColumnsList}>
                      {hiddenColumns.length === 0 ? (
                        <span className={styles.emptyMessage}>Arrastra aquí para ocultar</span>
                      ) : (
                        hiddenColumns.map(column => (
                          <div
                            key={column.key}
                            draggable={!column.fixed && editMode}
                            onDragStart={(e) => !column.fixed && handleDragStart(e, column.key)}
                            onDragEnd={handleDragEnd}
                            className={`${styles.columnPill} ${draggedColumn === column.key ? styles.dragging : ''}`}
                            onClick={() => !draggedColumn && !column.fixed && toggleColumnVisibility(column.key)}
                          >
                            {!column.fixed && <GripVertical size={14} />}
                            {column.header}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            )}

            {/* Headers normales */}
            {totalVisibleColumns > 0 && (
              <tr>
                {rowSelection && (
                  <th className={styles.selectionCell} style={{ width: 44 }}>
                    <IndeterminateCheckbox
                      className={styles.selectionCheckbox}
                      aria-label={rowSelection.selectVisibleLabel || 'Seleccionar filas visibles'}
                      checked={allVisibleRowsSelected}
                      indeterminate={!allVisibleRowsSelected && someVisibleRowsSelected}
                      disabled={visibleSelectableKeys.length === 0}
                      onClick={(event) => event.stopPropagation()}
                      onChange={handleToggleVisibleRows}
                    />
                  </th>
                )}
                {visibleColumns.map((column) => (
                  <th
                    key={column.key}
                    draggable={!column.fixed && columnEditMode}
                    onDragStart={(e) => !column.fixed && handleDragStart(e, column.key)}
                    onDragEnd={handleDragEnd}
                    onDragOver={!column.fixed ? handleDragOver : undefined}
                    onDragEnter={(e) => !column.fixed && handleDragEnter(e, column.key)}
                    onDrop={(e) => !column.fixed && handleDrop(e, column.key)}
                    className={`${column.sortable && !columnEditMode ? styles.sortable : ''} ${columnEditMode && !column.fixed ? styles.draggable : ''} ${draggedColumn === column.key ? styles.dragging : ''} ${dragOverColumn === column.key && draggedColumn && draggedColumn !== column.key ? styles.dragOver : ''}`}
                    style={{ width: column.width }}
                  >
                    <div className={styles.headerCell}>
                      {columnEditMode && !column.fixed && (
                        <GripVertical size={14} className={styles.gripIcon} />
                      )}
                      <span
                        onClick={() => !columnEditMode && column.sortable && handleSort(column.key)}
                        className={styles.headerText}
                      >
                        {column.header}
                      </span>
                      {columnEditMode && !column.fixed && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleColumnVisibility(column.key) }}
                          className={styles.hideButton}
                          title="Ocultar columna"
                        >
                          <XIcon size={14} />
                        </button>
                      )}
                      {!columnEditMode && column.sortable && sortBy === column.key && (
                        <span className={styles.sortIcon}>
                          {sortOrder === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {paginatedData.length === 0 ? (
              <tr>
                <td colSpan={totalVisibleColumns || 1} className={styles.empty}>
                  {searchTerm ? 'No se encontraron resultados' : emptyMessage}
                </td>
              </tr>
            ) : (
              paginatedData.map((item) => {
                const rowKey = keyExtractor(item)
                const rowStyle: React.CSSProperties = {
                  // Borde lateral en lugar de fondo de color
                  borderLeft: item.level === 'adset'
                    ? '3px solid var(--color-primary)'
                    : item.level === 'ad'
                    ? '3px solid var(--color-text-tertiary)'
                    : '3px solid transparent',
                  fontSize: item.level === 'campaign'
                    ? 'var(--font-size-base)'
                    : item.level === 'adset'
                    ? 'var(--font-size-sm)'
                    : item.level === 'ad'
                    ? 'var(--font-size-xs)'
                    : undefined,
                  fontWeight: item.level === 'campaign'
                    ? 'var(--font-weight-semibold)'
                    : item.level === 'adset'
                    ? 'var(--font-weight-medium)'
                    : undefined
                }

                return (
                  <tr
                    key={rowKey}
                    className={`${onRowClick ? styles.clickable : ''} ${rowClassName?.(item) ?? ''}`.trim()}
                    onClick={() => onRowClick?.(item)}
                    data-level={item.level || ''}
                    data-row-key={rowKey}
                    style={rowStyle}
                  >
                    {rowSelection && (
                      <td className={styles.selectionCell} onClick={(event) => event.stopPropagation()}>
                        {!rowSelection.isRowDisabled?.(item) && (
                          <input
                            className={styles.selectionCheckbox}
                            type="checkbox"
                            checked={selectedKeySet.has(rowKey)}
                            aria-label={`Seleccionar ${rowSelection.getRowLabel?.(item) || 'fila'}`}
                            onChange={() => handleToggleRowSelection(item)}
                          />
                        )}
                      </td>
                    )}
                    {visibleColumns.map((column) => (
                      <td key={column.key} style={{
                        color: item.level === 'ad'
                          ? 'var(--color-text-secondary)'
                          : item.level === 'adset'
                          ? 'var(--color-primary)'
                          : undefined
                      }}>
                        {column.render
                          ? column.render(item[column.key], item)
                          : item[column.key]}
                      </td>
                    ))}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {paginated && totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageButton}
            disabled={currentPage === 1}
            onClick={() => setCurrentPage(currentPage - 1)}
          >
            <ChevronLeft size={16} />
          </button>

          <div className={styles.pageNumbers}>
            {Array.from({ length: Math.min(9, totalPages) }, (_, i) => {
              let pageNum
              if (totalPages <= 9) {
                // Mostrar todas las páginas si hay 9 o menos
                pageNum = i + 1
              } else if (currentPage <= 5) {
                // Mostrar las primeras 9 páginas
                pageNum = i + 1
              } else if (currentPage >= totalPages - 4) {
                // Mostrar las últimas 9 páginas
                pageNum = totalPages - 8 + i
              } else {
                // Centrar la página actual (4 antes, 4 después)
                pageNum = currentPage - 4 + i
              }

              return (
                <button
                  key={pageNum}
                  className={`${styles.pageNumber} ${currentPage === pageNum ? styles.active : ''}`}
                  onClick={() => setCurrentPage(pageNum)}
                >
                  {pageNum}
                </button>
              )
            })}
          </div>

          <button
            className={styles.pageButton}
            disabled={currentPage === totalPages}
            onClick={() => setCurrentPage(currentPage + 1)}
          >
            <ChevronRight size={16} />
          </button>

          <span className={styles.pageInfo}>
            {((currentPage - 1) * pageSize) + 1} - {Math.min(currentPage * pageSize, filteredData.length)} de {filteredData.length}
          </span>
        </div>
      )}
    </div>
  )
}
