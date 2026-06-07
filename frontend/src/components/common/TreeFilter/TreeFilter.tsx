import React, { useState, useMemo, useEffect, useRef } from 'react'
import {
  Filter,
  ChevronDown,
  ChevronRight,
  Search,
  Check,
  FileText,
  Target,
  Share2,
  Smartphone,
  Globe,
  Monitor,
  MapPin,
  UserCheck,
  Layers
} from 'lucide-react'
import { AdHierarchyMenu } from './AdHierarchyMenu'
import { HelpTooltip } from '../HelpTooltip'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'

// Estructura del árbol de filtros con todas las categorías disponibles
interface FilterNode {
  id: string
  label: string
  icon?: React.ComponentType<any>
  children?: FilterNode[]
  field?: string // Campo real en la DB
  value?: string | number // Valor específico para filtrar
  count?: number // Conteo de items con este filtro
}

interface AdHierarchyNode {
  platform: string
  platform_id: string
  count: number
  campaigns: Array<{
    id: string
    name: string
    count: number
    adsets: Array<{
      id: string
      name: string
      count: number
      ads: Array<{
        id: string
        name: string
        count: number
      }>
    }>
  }>
}

interface TreeFilterProps {
  // Datos disponibles para construir el árbol dinámicamente
  availableData?: {
    pages?: Array<{ page: string; count: number }>
    campaigns?: Array<{ name: string; count: number }>
    adsets?: Array<{ name: string; count: number }>
    ads?: Array<{ name: string; count: number }>
    sources?: Array<{ name: string; count: number }>
    devices?: Array<{ name: string; count: number }>
    browsers?: Array<{ name: string; count: number }>
    os?: Array<{ name: string; count: number }>
    countries?: Array<{ name: string; count: number }>
    placements?: Array<{ name: string; count: number }>
    conversions?: Array<{ stage: string; name: string; count: number }>
    trackingSources?: Array<{ name: string; value: string; count: number }>
    siteTypes?: Array<{ name: string; value: string; count: number }>
    nativeSites?: Array<{ name: string; value: string; count: number }>
    nativeForms?: Array<{ name: string; value: string; count: number }>
    nativeConversions?: Array<{ name: string; value: string; count: number }>
    statuses?: Array<{ name: string; value?: string; count: number }>
    adsHierarchy?: Array<AdHierarchyNode>
  }
  selectedFilters: Record<string, string[]>
  onFilterChange: (filters: Record<string, string[]>) => void
}

export function TreeFilter({
  availableData = {},
  selectedFilters,
  onFilterChange
}: TreeFilterProps) {
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [showSearchResults, setShowSearchResults] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cerrar dropdown cuando se hace click afuera
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setHoveredCategory(null)
        setShowSearchResults(false)
        setSearchTerm('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Limpiar timeout de hover cuando se desmonta el componente
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current)
      }
    }
  }, [])

  // Construir el árbol de filtros basado en los datos disponibles
  const filterTree = useMemo<FilterNode[]>(() => {
    const tree: FilterNode[] = []

    // Categoría: Estado
    if (availableData.statuses?.length) {
      tree.push({
        id: 'statuses',
        label: 'Estado',
        icon: Layers,
        children: availableData.statuses.map(status => ({
          id: `status_${status.value || status.name}`,
          label: status.name,
          field: 'status',
          value: status.value || status.name,
          count: status.count
        }))
      })
    }

    // Categoría: Origen del tracking
    if (availableData.trackingSources?.length) {
      tree.push({
        id: 'tracking_sources',
        label: 'Origen tracking',
        icon: Layers,
        children: availableData.trackingSources.map(source => ({
          id: `tracking_source_${source.value}`,
          label: source.name,
          field: 'tracking_source',
          value: source.value,
          count: source.count
        }))
      })
    }

    // Categoría: Tipo de Site nativo
    if (availableData.siteTypes?.length) {
      tree.push({
        id: 'site_types',
        label: 'Tipo de Site',
        icon: Layers,
        children: availableData.siteTypes.map(siteType => ({
          id: `site_type_${siteType.value}`,
          label: siteType.name,
          field: 'site_type',
          value: siteType.value,
          count: siteType.count
        }))
      })
    }

    // Categoría: Sites nativos
    if (availableData.nativeSites?.length) {
      tree.push({
        id: 'native_sites',
        label: 'Sites nativos',
        icon: FileText,
        children: availableData.nativeSites.map(site => ({
          id: `native_site_${site.value}`,
          label: site.name,
          field: 'site_id',
          value: site.value,
          count: site.count
        }))
      })
    }

    // Categoría: Formularios nativos
    if (availableData.nativeForms?.length) {
      tree.push({
        id: 'native_forms',
        label: 'Formularios',
        icon: FileText,
        children: availableData.nativeForms.map(form => ({
          id: `native_form_${form.value}`,
          label: form.name,
          field: 'form_site_id',
          value: form.value,
          count: form.count
        }))
      })
    }

    // Categoría: Conversiones de Sites
    if (availableData.nativeConversions?.length) {
      tree.push({
        id: 'native_conversions',
        label: 'Conversiones Sites',
        icon: UserCheck,
        children: availableData.nativeConversions.map(conversion => ({
          id: `native_conversion_${conversion.value}`,
          label: conversion.name,
          field: 'native_conversion_source',
          value: conversion.value,
          count: conversion.count
        }))
      })
    }

    // Categoría: Conversión
    if (availableData.conversions?.length) {
      tree.push({
        id: 'conversion',
        label: 'Conversión',
        icon: UserCheck,
        children: availableData.conversions.map(c => ({
          id: `conversion_${c.stage}`,
          label: c.name,
          field: 'conversion_stage',
          value: c.stage,
          count: c.count
        }))
      })
    }

    // Categoría: Páginas
    if (availableData.pages?.length) {
      tree.push({
        id: 'pages',
        label: 'Páginas',
        icon: FileText,
        children: availableData.pages.map(p => ({
          id: `page_${p.page}`,
          label: p.page,
          field: 'landing_url',
          value: p.page,
          count: p.count
        }))
      })
    }

    // Categoría: Plataformas (utm_source > utm_campaign > utm_medium > utm_content)
    // Guardamos la jerarquía completa en vez de lista plana
    if (availableData.adsHierarchy?.length) {
      tree.push({
        id: 'ads',
        label: 'Plataformas',
        icon: Target,
        // No ponemos children aquí, se renderiza con lógica especial de cascada
      })
    } else if (availableData.ads?.length) {
      // Fallback a la lista plana si no hay jerarquía
      tree.push({
        id: 'ads',
        label: 'Plataformas',
        icon: Target,
        children: availableData.ads.map(a => ({
          id: `ad_${a.name}`,
          label: a.name,
          field: 'utm_content',
          value: a.name,
          count: a.count
        }))
      })
    }

    // Categoría: Fuentes de tráfico
    if (availableData.sources?.length) {
      tree.push({
        id: 'sources',
        label: 'Fuentes',
        icon: Share2,
        children: availableData.sources.map(s => ({
          id: `source_${s.name}`,
          label: s.name,
          field: 'utm_source',
          value: s.name,
          count: s.count
        }))
      })
    }

    // Categoría: Dispositivos
    if (availableData.devices?.length) {
      tree.push({
        id: 'devices',
        label: 'Dispositivos',
        icon: Smartphone,
        children: availableData.devices.map(d => ({
          id: `device_${d.name}`,
          label: d.name,
          field: 'device_type',
          value: d.name,
          count: d.count
        }))
      })
    }

    // Categoría: Navegadores
    if (availableData.browsers?.length) {
      tree.push({
        id: 'browsers',
        label: 'Navegadores',
        icon: Globe,
        children: availableData.browsers.map(b => ({
          id: `browser_${b.name}`,
          label: b.name,
          field: 'browser',
          value: b.name,
          count: b.count
        }))
      })
    }

    // Categoría: Sistemas Operativos
    if (availableData.os?.length) {
      tree.push({
        id: 'os',
        label: 'Sistemas',
        icon: Monitor,
        children: availableData.os.map(o => ({
          id: `os_${o.name}`,
          label: o.name,
          field: 'os',
          value: o.name,
          count: o.count
        }))
      })
    }

    // Categoría: Ubicaciones/Placements
    if (availableData.placements?.length) {
      tree.push({
        id: 'placements',
        label: 'Ubicaciones',
        icon: MapPin,
        children: availableData.placements.map(p => ({
          id: `placement_${p.name}`,
          label: p.name,
          field: 'placement',
          value: p.name,
          count: p.count
        }))
      })
    }

    return tree
  }, [availableData])

  const singleCategoryId = filterTree.length === 1 ? filterTree[0]?.id ?? null : null

  useEffect(() => {
    if (!isOpen || !singleCategoryId || showSearchResults) return
    setHoveredCategory(singleCategoryId)
  }, [isOpen, showSearchResults, singleCategoryId])

  // Manejar hover con delay para evitar flicker
  const handleCategoryHover = (categoryId: string) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredCategory(categoryId)
    }, 100)
  }

  const handleCategoryLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }

    if (singleCategoryId) {
      setHoveredCategory(singleCategoryId)
      return
    }

    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredCategory(null)
    }, 150)
  }

  // Manejar selección de filtros
  const handleFilterToggle = (field: string, value: string) => {
    const currentValues = selectedFilters[field] || []
    const newValues = currentValues.includes(value)
      ? currentValues.filter(v => v !== value)
      : [...currentValues, value]

    const newFilters = {
      ...selectedFilters,
      [field]: newValues
    }

    // Limpiar campos vacíos
    Object.keys(newFilters).forEach(key => {
      if (!newFilters[key]?.length) {
        delete newFilters[key]
      }
    })

    onFilterChange(newFilters)
  }

  // Verificar si un nodo está seleccionado
  const isNodeSelected = (node: FilterNode): boolean => {
    if (!node.field || !node.value) return false
    return selectedFilters[node.field]?.includes(String(node.value)) || false
  }

  // Contar filtros activos
  const activeFiltersCount = useMemo(() => {
    return Object.values(selectedFilters).reduce((acc, values) => acc + values.length, 0)
  }, [selectedFilters])
  const hasActiveFilters = activeFiltersCount > 0
  const availableFilterLabels = filterTree.map(node => node.label.toLocaleLowerCase('es-MX')).join(', ')
  const filterTooltip = activeFiltersCount > 0
    ? 'Abre el panel para revisar, sumar o quitar filtros activos.'
    : availableFilterLabels
      ? `Sin filtros aplicados. Abre para filtrar por ${availableFilterLabels}.`
      : 'Sin filtros aplicados.'
  const preparedFilterSearch = useMemo(() => prepareSearchQuery(searchTerm), [searchTerm])
  const filterSearchIndexes = useMemo(() => {
    const indexes = new Map<string, ReturnType<typeof buildSearchIndex>>()

    filterTree.forEach(category => {
      category.children?.forEach(child => {
        indexes.set(child.id, buildSearchIndex(child.label))
      })
    })

    return indexes
  }, [filterTree])
  const matchesFilterSearch = (node: FilterNode) => {
    return searchIndexIncludes(filterSearchIndexes.get(node.id) ?? buildSearchIndex(node.label), preparedFilterSearch)
  }

  const handleClearAllFilters = () => {
    onFilterChange({})
    setHoveredCategory(singleCategoryId)
    setShowSearchResults(false)
    setSearchTerm('')
  }

  // Filtrar nodos por búsqueda
  const getFilteredChildren = (node: FilterNode) => {
    if (!node.children) return []
    if (!searchTerm) return node.children

    return node.children.filter(matchesFilterSearch)
  }

  // Obtener resultados de búsqueda global
  const getGlobalSearchResults = () => {
    if (!searchTerm) return []

    const results: { category: FilterNode; items: FilterNode[] }[] = []

    filterTree.forEach(category => {
      if (!category.children) return

      const matchingItems = category.children.filter(matchesFilterSearch)

      if (matchingItems.length > 0) {
        results.push({
          category,
          items: matchingItems
        })
      }
    })

    return results
  }

  // Obtener conteo de seleccionados por categoría
  const getSelectedCountForCategory = (node: FilterNode): number => {
    if (!node.children) return 0
    return node.children.filter(child =>
      child.field && child.value && isNodeSelected(child)
    ).length
  }

  // Manejar cambios en el término de búsqueda
  const handleSearchChange = (value: string) => {
    setSearchTerm(value)
    if (value.trim()) {
      setShowSearchResults(true)
      setHoveredCategory(null)
    } else {
      setShowSearchResults(false)
      setHoveredCategory(singleCategoryId)
    }
  }

  const handleToggleOpen = () => {
    const nextOpen = !isOpen

    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current)
    }

    setIsOpen(nextOpen)

    if (nextOpen) {
      setHoveredCategory(singleCategoryId)
      return
    }

    setHoveredCategory(null)
    setShowSearchResults(false)
    setSearchTerm('')
  }

  return (
    <div ref={dropdownRef} className="relative">
      {/* Botón principal */}
      <HelpTooltip content={filterTooltip}>
        <button
          type="button"
          onClick={handleToggleOpen}
          aria-expanded={isOpen}
          data-ristak-dropdown-trigger
          className={`
            flex items-center gap-2 px-3 py-2
            rounded-lg transition-all duration-200
            bg-[var(--color-background-secondary)]
            ${isOpen ? '' : 'hover:bg-[var(--color-background-tertiary)]'}
          `}
          style={{ border: '1px solid var(--color-border-subtle)' }}
        >
          <Filter className="w-4 h-4 text-[var(--color-text-primary)]" />
          <span className="text-sm text-[var(--color-text-primary)]">
            {activeFiltersCount > 0 ? `Filtros (${activeFiltersCount})` : 'Todos'}
          </span>
          <ChevronDown
            className={`
              w-3 h-3 text-[var(--color-text-secondary)] transition-transform duration-200
              ${isOpen ? 'rotate-180' : ''}
            `}
          />
        </button>
      </HelpTooltip>

      {/* Dropdown principal con menú tipo navegación */}
      {isOpen && (
        <div
          className="absolute top-full left-0 mt-2 z-50 bg-[var(--color-background-primary)] rounded-lg shadow-xl animate-fadeIn flex"
          style={{ border: '1px solid var(--color-border-subtle)' }}
          onMouseLeave={handleCategoryLeave}
          data-ristak-dropdown-panel
        >
          {/* Panel izquierdo: Categorías principales */}
          <div className="w-48" style={{ borderRight: '1px solid var(--color-border-subtle)' }}>
            {/* Header con búsqueda */}
            <div className="p-3" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-[var(--color-text-tertiary)]" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Buscar..."
                  className="w-full pl-8 pr-3 py-2 text-sm rounded-md
                           bg-[var(--color-background-secondary)] border border-[var(--color-border)]
                           text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)]
                           focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/30 focus:border-[var(--color-accent)]/50
                           transition-colors duration-200"
                />
              </div>
            </div>

            {hasActiveFilters && (
              <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                <button
                  type="button"
                  onClick={handleClearAllFilters}
                  aria-label={`Borrar todo: ${activeFiltersCount} filtros activos`}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-sm
                           text-red-500 hover:bg-red-500/10 rounded-md transition-colors duration-150"
                >
                  <span>Borrar todo</span>
                  <span className="text-xs bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded">
                    {activeFiltersCount}
                  </span>
                </button>
              </div>
            )}

            {/* Lista de categorías o resultados de búsqueda */}
            <div className="py-2 max-h-80 overflow-y-auto">
              {showSearchResults ? (
                <div className="text-center py-4 text-sm text-[var(--color-text-secondary)] px-3">
                  {getGlobalSearchResults().length > 0
                    ? `${getGlobalSearchResults().reduce((acc, r) => acc + r.items.length, 0)} resultados`
                    : 'No se encontraron resultados'
                  }
                </div>
              ) : filterTree.length > 0 ? (
                filterTree.map((category, index) => {
                  const Icon = category.icon
                  const selectedCount = getSelectedCountForCategory(category)
                  const isHovered = hoveredCategory === category.id

                  return (
                    <div
                      key={category.id}
                      onMouseEnter={() => handleCategoryHover(category.id)}
                      data-ristak-dropdown-item
                      data-active={isHovered ? 'true' : undefined}
                      data-selected={selectedCount > 0 ? 'true' : undefined}
                      className={`
                        flex items-center justify-between px-3 py-2 cursor-pointer
                        transition-all duration-150
                        ${isHovered ? 'bg-[var(--color-background-tertiary)] !important' : 'hover:bg-[var(--color-background-tertiary)]'}
                        ${selectedCount > 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'}
                      `}
                      style={{ backgroundColor: index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                    >
                      <div className="flex items-center gap-2">
                        {Icon && <Icon className="w-4 h-4" />}
                        <span className="text-sm font-medium">{category.label}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {selectedCount > 0 && (
                          <span className="text-xs bg-[var(--color-accent)]/20 text-[var(--color-accent)] px-1.5 py-0.5 rounded">
                            {selectedCount}
                          </span>
                        )}
                        <ChevronRight className="w-3 h-3 text-[var(--color-text-secondary)]" />
                      </div>
                    </div>
                  )
                })
              ) : (
                <div className="text-center py-4 text-sm text-[var(--color-text-tertiary)] px-3">
                  No hay datos disponibles
                </div>
              )}

            </div>
          </div>

          {/* Panel derecho: Opciones de la categoría con hover o resultados de búsqueda */}
          {(hoveredCategory || showSearchResults) && (
            <>
              {/* JERARQUÍA ESPECIAL PARA ANUNCIOS: 4 paneles en cascada */}
              {hoveredCategory === 'ads' && !showSearchResults && availableData.adsHierarchy?.length ? (
                <AdHierarchyMenu
                  adsHierarchy={availableData.adsHierarchy}
                  selectedFilters={selectedFilters}
                  onFilterToggle={handleFilterToggle}
                  onFilterChange={onFilterChange}
                />
              ) : (
                <div
                  className="w-64 overflow-y-auto"
                  style={{ maxHeight: 'calc(100vh - 160px)' }}
                  onMouseEnter={() => {
                    if (hoverTimeoutRef.current) {
                      clearTimeout(hoverTimeoutRef.current)
                    }
                    setHoveredCategory(hoveredCategory)
                  }}
                >
                  {showSearchResults ? (
                // Mostrar resultados de búsqueda global
                <div className="py-2">
                  {getGlobalSearchResults().map(({ category, items }) => {
                    const Icon = category.icon
                    return (
                      <div key={category.id} className="mb-3">
                        {/* Título de la categoría */}
                        <div className="px-3 py-1.5 mb-1 flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                          {Icon && <Icon className="w-3.5 h-3.5 text-[var(--color-text-secondary)]" />}
                          <h3 className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
                            {category.label}
                          </h3>
                          <span className="text-xs text-[var(--color-text-tertiary)]">({items.length})</span>
                        </div>

                        {/* Lista de opciones */}
                        <div>
                          {items.map((item, index) => {
                            const isSelected = isNodeSelected(item)

                            return (
                              <div
                                key={item.id}
                                data-ristak-dropdown-item
                                data-selected={isSelected ? 'true' : undefined}
                                onClick={() => {
                                  if (item.field && item.value) {
                                    handleFilterToggle(item.field, String(item.value))
                                  }
                                }}
                                className={`
                                  flex items-center gap-2 px-3 py-2 cursor-pointer
                                  transition-all duration-150
                                  ${isSelected
                                    ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                                    : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                                  }
                                `}
                                style={{ backgroundColor: !isSelected && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                              >
                                <span className="text-sm flex-1">{item.label}</span>

                                {item.count !== undefined && (
                                  <span className="text-xs text-[var(--color-text-secondary)]">
                                    {item.count}
                                  </span>
                                )}

                                <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                                  {isSelected && (
                                    <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />
                                  )}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                // Mostrar opciones de categoría con hover
                filterTree.map(category => {
                  if (category.id !== hoveredCategory) return null

                  const filteredChildren = getFilteredChildren(category)

                  if (filteredChildren.length === 0) {
                    return (
                      <div key={category.id} className="p-4 text-center text-sm text-[var(--color-text-tertiary)]">
                        {searchTerm ? 'No se encontraron resultados' : 'Sin opciones disponibles'}
                      </div>
                    )
                  }

                  return (
                    <div key={category.id} className="py-2">
                      {/* Título de la categoría */}
                      <div className="px-3 py-2 mb-1" style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                          {category.label}
                        </h3>
                      </div>

                      {/* Lista de opciones */}
                      <div>
                        {filteredChildren.map((item, index) => {
                          const isSelected = isNodeSelected(item)

                          return (
                            <div
                              key={item.id}
                              data-ristak-dropdown-item
                              data-selected={isSelected ? 'true' : undefined}
                              onClick={() => {
                                if (item.field && item.value) {
                                  handleFilterToggle(item.field, String(item.value))
                                }
                              }}
                              className={`
                                flex items-center gap-2 px-3 py-2 cursor-pointer
                                transition-all duration-150
                                ${isSelected
                                  ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 !important'
                                  : 'hover:bg-[var(--color-background-tertiary)] text-[var(--color-text-primary)]'
                                }
                              `}
                              style={{ backgroundColor: !isSelected && index % 2 === 1 ? 'var(--table-row-even)' : undefined }}
                            >
                              <span className="text-sm flex-1">{item.label}</span>

                              {item.count !== undefined && (
                                <span className="text-xs text-[var(--color-text-secondary)]">
                                  {item.count}
                                </span>
                              )}

                              <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                                {isSelected && (
                                  <Check className="w-4 h-4 stroke-[2.5] text-[var(--color-accent)]" />
                                )}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })
              )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
