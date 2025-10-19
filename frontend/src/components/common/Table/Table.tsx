import React, { useState, useMemo, useEffect } from 'react'
import {
  Search,
  ChevronUp,
  ChevronDown,
  Download,
  Settings,
  Check,
  GripVertical,
  X as XIcon,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import { useTableConfig } from '@/hooks'
import { TabList } from '../TabList'
import styles from './Table.module.css'

export interface Column<T> {
  key: string
  header: string
  render?: (value: any, item: T) => React.ReactNode
  sortable?: boolean
  visible?: boolean
  width?: string
  fixed?: boolean // Columna que no se puede mover ni ocultar
}

interface FilterOption {
  label: string
  value: string
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
  exportable?: boolean
  onExport?: () => void
  filters?: FilterOption[]
  activeFilter?: string
  onFilterChange?: (filter: string) => void
  tableId?: string // ID para guardar config en rstk_config
  initialSortBy?: string // Columna para ordenar inicialmente
  initialSortOrder?: 'asc' | 'desc' // Orden inicial
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
  exportable = true,
  onExport,
  filters,
  activeFilter = 'all',
  onFilterChange,
  tableId,
  initialSortBy,
  initialSortOrder = 'asc'
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
      return initialColumns
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

    initialColumns.forEach(col => {
      if (!savedTableConfig.find((c: any) => c.id === col.key)) {
        orderedColumns.push(col)
      }
    })

    return orderedColumns
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
    } catch (error) {
      console.error('Error guardando configuración de tabla:', error)
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
    const newColumns = columns.map(col =>
      col.key === columnKey ? { ...col, visible: !col.visible } : col
    )
    setColumns(newColumns)
    saveColumnsConfig(newColumns)
  }

  const visibleColumns = columns.filter(col => col.visible !== false)
  const hiddenColumns = columns.filter(col => !col.fixed && col.visible === false)

  const filteredData = useMemo(() => {
    if (!Array.isArray(data)) {
      // TODO: Implement proper logging service
      return []
    }

    let filtered = [...data]

    if (searchTerm) {
      filtered = filtered.filter(item =>
        Object.values(item).some(value =>
          String(value).toLowerCase().includes(searchTerm.toLowerCase())
        )
      )
    }

    if (sortBy) {
      filtered.sort((a, b) => {
        const aValue = a[sortBy]
        const bValue = b[sortBy]

        if (aValue === bValue) return 0

        const result = aValue > bValue ? 1 : -1
        return sortOrder === 'asc' ? result : -result
      })
    }

    return filtered
  }, [data, searchTerm, sortBy, sortOrder])

  const paginatedData = useMemo(() => {
    if (!paginated) return filteredData

    const start = (currentPage - 1) * pageSize
    const end = start + pageSize
    return filteredData.slice(start, end)
  }, [filteredData, currentPage, pageSize, paginated])

  const totalPages = Math.ceil(filteredData.length / pageSize)

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortOrder('asc')
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingContainer}>
        <div className={styles.loadingText}>Cargando...</div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.tableHeader}>
        <div className={styles.leftControls}>
          {searchable && (
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
          )}

          {filters && (
            <TabList
              tabs={filters}
              activeTab={activeFilter}
              onChange={onFilterChange ?? (() => {})}
            />
          )}
        </div>

        <div className={styles.tableActions}>
          <button
            className={`${styles.actionButton} ${editMode ? styles.active : ''}`}
            onClick={() => setEditMode(!editMode)}
            title={editMode ? "Finalizar edición" : "Editar columnas"}
          >
            {editMode ? (
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

          {exportable && (
            <button
              className={styles.actionButton}
              onClick={onExport}
              title="Exportar CSV"
            >
              <Download size={18} />
            </button>
          )}
        </div>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            {/* Fila de columnas ocultas en modo edición */}
            {editMode && (
              <tr className={styles.hiddenColumnsRow}>
                <td
                  colSpan={visibleColumns.length || 1}
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
            {visibleColumns.length > 0 && (
              <tr>
                {visibleColumns.map((column) => (
                  <th
                    key={column.key}
                    draggable={!column.fixed && editMode}
                    onDragStart={(e) => !column.fixed && handleDragStart(e, column.key)}
                    onDragEnd={handleDragEnd}
                    onDragOver={!column.fixed ? handleDragOver : undefined}
                    onDragEnter={(e) => !column.fixed && handleDragEnter(e, column.key)}
                    onDrop={(e) => !column.fixed && handleDrop(e, column.key)}
                    className={`${column.sortable && !editMode ? styles.sortable : ''} ${editMode && !column.fixed ? styles.draggable : ''} ${draggedColumn === column.key ? styles.dragging : ''} ${dragOverColumn === column.key && draggedColumn && draggedColumn !== column.key ? styles.dragOver : ''}`}
                    style={{ width: column.width }}
                  >
                    <div className={styles.headerCell}>
                      {editMode && !column.fixed && (
                        <GripVertical size={14} className={styles.gripIcon} />
                      )}
                      <span
                        onClick={() => !editMode && column.sortable && handleSort(column.key)}
                        className={styles.headerText}
                      >
                        {column.header}
                      </span>
                      {editMode && !column.fixed && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleColumnVisibility(column.key) }}
                          className={styles.hideButton}
                          title="Ocultar columna"
                        >
                          <XIcon size={14} />
                        </button>
                      )}
                      {!editMode && column.sortable && sortBy === column.key && (
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
                <td colSpan={visibleColumns.length || 1} className={styles.empty}>
                  {searchTerm ? 'No se encontraron resultados' : emptyMessage}
                </td>
              </tr>
            ) : (
              paginatedData.map((item) => {
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
                    key={keyExtractor(item)}
                    className={onRowClick ? styles.clickable : ''}
                    onClick={() => onRowClick?.(item)}
                    data-level={item.level || ''}
                    style={rowStyle}
                  >
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
