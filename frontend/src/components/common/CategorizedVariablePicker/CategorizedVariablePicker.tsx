import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, X } from 'lucide-react'
import { useAnchoredPortal } from '@/hooks/useAnchoredPortal'
import { cn } from '@/utils/cn'
import { Button } from '../Button'
import { SearchField } from '../SearchField'
import styles from './CategorizedVariablePicker.module.css'

export interface CategorizedVariablePickerCategory {
  id: string
  label: string
  unavailableReason?: string
}

export interface CategorizedVariablePickerOption {
  value: string
  label: string
  category: string
  categoryLabel?: string
  pathLabels?: string[]
  path?: string
  hiddenFromPicker?: boolean
}

interface PickerTreeNode {
  id: string
  label: string
  option?: CategorizedVariablePickerOption
  children: PickerTreeNode[]
}

interface PickerTriggerRenderProps {
  open: boolean
  toggle: () => void
  triggerProps: {
    type: 'button'
    'aria-expanded': boolean
    'aria-haspopup': 'dialog'
    'aria-label': string
    onPointerDown: React.PointerEventHandler<HTMLButtonElement>
    onClick: React.MouseEventHandler<HTMLButtonElement>
  }
}

interface CategorizedVariablePickerProps {
  variables: CategorizedVariablePickerOption[]
  categories: CategorizedVariablePickerCategory[]
  onSelect: (value: string, variable: CategorizedVariablePickerOption) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  className?: string
  anchorRef?: React.RefObject<HTMLElement | null>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  renderTrigger?: (props: PickerTriggerRenderProps) => React.ReactNode
  align?: 'start' | 'center' | 'end'
  dropdownWidth?: number
  dropdownMaxHeight?: number
  disabled?: boolean
  'aria-label'?: string
}

function normalizeSearchValue(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function buildVariableTree(items: CategorizedVariablePickerOption[]): PickerTreeNode[] {
  const root: PickerTreeNode[] = []
  const findOrCreate = (siblings: PickerTreeNode[], id: string, label: string) => {
    let node = siblings.find(candidate => candidate.id === id)
    if (!node) {
      node = { id, label, children: [] }
      siblings.push(node)
    }
    return node
  }
  const pathParts = (path: string) => path.match(/[^[.\]]+|\[\d+\]/g) || []

  items.forEach(variable => {
    const labels = variable.pathLabels?.length ? variable.pathLabels : [variable.label]
    const segments = pathParts(variable.path || variable.value)
    let siblings = root

    labels.forEach((label, index) => {
      const localId = segments.length === labels.length
        ? segments.slice(0, index + 1).join('')
        : labels.slice(0, index + 1).join('/')
      const node = findOrCreate(siblings, `${variable.category}:${localId}`, label)
      if (index === labels.length - 1) node.option = variable
      siblings = node.children
    })
  })

  return root
}

export const CategorizedVariablePicker: React.FC<CategorizedVariablePickerProps> = ({
  variables,
  categories,
  onSelect,
  placeholder = 'Variables',
  searchPlaceholder = 'Buscar variable o ruta…',
  emptyMessage = 'Sin variables que coincidan',
  className,
  anchorRef,
  open,
  onOpenChange,
  renderTrigger,
  align = 'start',
  dropdownWidth = 430,
  dropdownMaxHeight = 420,
  disabled = false,
  'aria-label': ariaLabel = 'Insertar variable'
}) => {
  const ownAnchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => new Set())
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set())
  const controlled = open !== undefined
  const pickerOpen = controlled ? Boolean(open) : internalOpen
  const resolvedAnchorRef = anchorRef || ownAnchorRef
  const {
    style: popoverPosition,
    placement: popoverPlacement,
    availableHeight
  } = useAnchoredPortal(resolvedAnchorRef, pickerOpen, {
    align,
    gap: 8,
    matchWidth: false,
    minWidth: dropdownWidth,
    maxWidth: dropdownWidth,
    maxHeight: dropdownMaxHeight,
    panelRef
  })

  const setOpen = useCallback((nextOpen: boolean) => {
    if (!controlled) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
    if (!nextOpen) {
      setQuery('')
      setExpandedCategories(new Set())
      setExpandedNodes(new Set())
    }
  }, [controlled, onOpenChange])

  const visibleCategories = useMemo(() => {
    const seen = new Set<string>()
    return categories.filter(category => {
      if (!category.id || seen.has(category.id)) return false
      seen.add(category.id)
      return true
    })
  }, [categories])

  const filteredByCategory = useMemo(() => {
    const normalized = normalizeSearchValue(query)
    return visibleCategories
      .map(category => ({
        category,
        items: variables.filter(variable => {
          if (variable.hiddenFromPicker || variable.category !== category.id) return false
          if (!normalized) return true
          return [
            variable.label,
            variable.pathLabels?.join(' ') || '',
            variable.value,
            `{{${variable.value}}}`,
            variable.categoryLabel || category.label
          ].some(value => normalizeSearchValue(value).includes(normalized))
        })
      }))
      .filter(group => group.items.length > 0 || Boolean(group.category.unavailableReason))
  }, [query, variables, visibleCategories])

  const isSearching = query.trim().length > 0

  useEffect(() => {
    if (!pickerOpen) {
      setQuery('')
      setExpandedCategories(new Set())
      setExpandedNodes(new Set())
    }
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!resolvedAnchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [pickerOpen, resolvedAnchorRef, setOpen])

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories(current => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const toggleNode = (nodeId: string) => {
    setExpandedNodes(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const selectVariable = (variable: CategorizedVariablePickerOption) => {
    onSelect(variable.value, variable)
    setOpen(false)
  }

  const renderVariableTree = (nodes: PickerTreeNode[], depth = 0): React.ReactNode =>
    nodes.map(node => {
      const depthStyle = { '--variable-picker-indent': `${depth * 14}px` } as React.CSSProperties
      if (node.option) {
        return (
          <button
            key={node.id}
            type="button"
            className={styles.item}
            style={depthStyle}
            onPointerDown={event => event.preventDefault()}
            onClick={() => node.option && selectVariable(node.option)}
          >
            <span className={styles.variableChip}>{node.label}</span>
          </button>
        )
      }

      const expanded = isSearching || expandedNodes.has(node.id)
      return (
        <div key={node.id}>
          <button
            type="button"
            className={styles.subcategory}
            style={depthStyle}
            aria-expanded={expanded}
            onPointerDown={event => event.preventDefault()}
            onClick={() => toggleNode(node.id)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>{node.label}</span>
          </button>
          {expanded ? renderVariableTree(node.children, depth + 1) : null}
        </div>
      )
    })

  const toggle = () => {
    if (disabled) return
    setOpen(!pickerOpen)
  }

  const triggerProps: PickerTriggerRenderProps['triggerProps'] = {
    type: 'button',
    'aria-expanded': pickerOpen,
    'aria-haspopup': 'dialog',
    'aria-label': ariaLabel,
    onPointerDown: event => event.preventDefault(),
    onClick: toggle
  }

  const panel = pickerOpen && !disabled ? (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        ...popoverPosition,
        '--variable-picker-body-max-height': `${Math.max(0, availableHeight - 58)}px`
      } as React.CSSProperties}
      data-placement={popoverPlacement}
      data-ristak-dropdown-panel
    >
      <div className={styles.searchRow}>
        <SearchField
          autoFocus
          value={query}
          onChange={setQuery}
          onClear={() => setQuery('')}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          size="sm"
          onKeyDown={event => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.closeButton}
          onClick={() => setOpen(false)}
          title="Cerrar"
          aria-label="Cerrar selector de variables"
        >
          <X size={14} />
        </Button>
      </div>

      <div className={styles.body}>
        {filteredByCategory.length === 0 ? <p className={styles.empty}>{emptyMessage}</p> : null}
        {filteredByCategory.map(({ category, items }) => {
          const expanded = isSearching || expandedCategories.has(category.id)
          return (
            <div key={category.id}>
              <button
                type="button"
                className={styles.category}
                aria-expanded={expanded}
                onPointerDown={event => event.preventDefault()}
                onClick={() => toggleCategory(category.id)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{category.label}</span>
                {items.length > 0 ? <span className={styles.count}>{items.length}</span> : null}
              </button>
              {expanded ? (
                category.unavailableReason
                  ? <p className={styles.warning}>{category.unavailableReason}</p>
                  : renderVariableTree(buildVariableTree(items))
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  ) : null

  return (
    <span ref={ownAnchorRef} className={cn(styles.anchor, className)}>
      {renderTrigger ? renderTrigger({ open: pickerOpen, toggle, triggerProps }) : (
        <button
          {...triggerProps}
          className={styles.trigger}
          disabled={disabled}
          data-ristak-dropdown-trigger
        >
          <span>{placeholder}</span>
          <ChevronDown size={16} className={styles.triggerChevron} />
        </button>
      )}
      {typeof document !== 'undefined' && panel ? createPortal(panel, document.body) : null}
    </span>
  )
}
