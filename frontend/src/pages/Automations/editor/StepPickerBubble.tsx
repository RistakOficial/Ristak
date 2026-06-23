import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Link2, Play, Search, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  getCategoriesForKind,
  getDefinitionsByKind,
  type NodeDefinition,
  type NodeKind
} from './nodeRegistry'
import styles from './AutomationEditor.module.css'

export interface StepPickerAnchor {
  /** Posición en píxeles relativa al contenedor del editor */
  x: number
  y: number
}

interface StepPickerBubbleProps {
  kind: NodeKind
  /**
   * anchored: globo cerca del punto (drop, doble clic, disparadores).
   * docked: panel amplio fijo del lado derecho para usos heredados.
   */
  variant: 'anchored' | 'docked'
  /** Ajusta el globo alrededor del punto de anclaje. */
  placement?: 'point' | 'below-end' | 'left-start'
  anchor: StepPickerAnchor
  /** Tamaño del contenedor para no salirse de la pantalla */
  bounds: { width: number; height: number }
  /** Opción "conectar automáticamente" (cuando aplica) */
  connectLabel?: string
  connectEnabled?: boolean
  onToggleConnect?: (enabled: boolean) => void
  /** Muestra la sección "Paso inicial" para añadir un disparador */
  showStartStep?: boolean
  onSelectStartStep?: () => void
  definitionFilter?: (definition: NodeDefinition) => boolean
  onSelect: (definition: NodeDefinition) => void
  onClose: () => void
}

interface PickerSection {
  id: string
  label: string
  items: NodeDefinition[]
}

const ANCHORED_WIDTH = 460
const DOCKED_WIDTH = 500
const EDGE_GUTTER = 12

export const StepPickerBubble: React.FC<StepPickerBubbleProps> = ({
  kind,
  variant,
  placement = 'point',
  anchor,
  bounds,
  connectLabel,
  connectEnabled,
  onToggleConnect,
  showStartStep,
  onSelectStartStep,
  definitionFilter,
  onSelect,
  onClose
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const sections = useMemo<PickerSection[]>(() => {
    const definitions = getDefinitionsByKind(kind)
    const normalizedQuery = query.trim().toLowerCase()
    const matches = (definition: NodeDefinition) =>
      !normalizedQuery ||
      definition.label.toLowerCase().includes(normalizedQuery) ||
      (definition.description || '').toLowerCase().includes(normalizedQuery) ||
      (definition.brand || '').toLowerCase().includes(normalizedQuery)

    const result: PickerSection[] = []

    getCategoriesForKind(kind).forEach((category) => {
      const items = definitions
        .filter((definition) => definition.category === category.id)
        .filter((definition) => definitionFilter ? definitionFilter(definition) : true)
        .filter(matches)
      if (items.length > 0) {
        result.push({ id: category.id, label: category.label, items })
      }
    })

    return result
  }, [definitionFilter, kind, query])

  const flatItems = useMemo(
    () => sections.flatMap((section) => section.items.map((item) => ({ section: section.id, item }))),
    [sections]
  )

  useEffect(() => {
    setActiveIndex(0)
  }, [query, kind])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Cerrar con clic fuera
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  // Mantener visible el elemento activo al navegar con teclado
  useEffect(() => {
    rootRef.current
      ?.querySelector(`[data-picker-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(flatItems.length - 1, index + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const active = flatItems[activeIndex]
      if (active) onSelect(active.item)
    }
  }

  // Posicionamiento overlay: nunca empuja el layout ni mueve el canvas.
  const dockedStyle: React.CSSProperties = {
    right: 16,
    top: '50%',
    transform: 'translateY(-50%)',
    width: Math.min(DOCKED_WIDTH, bounds.width - 32),
    height: Math.min(bounds.height * 0.84, bounds.height - 32)
  }
  const anchoredWidth = Math.min(ANCHORED_WIDTH, Math.max(320, bounds.width - EDGE_GUTTER * 2))
  const anchoredVisibleHeight = Math.min(190, Math.max(90, bounds.height - EDGE_GUTTER * 2))
  const alignBeforeAnchor = placement === 'below-end' || placement === 'left-start'
  const anchoredLeft =
    alignBeforeAnchor
      ? anchor.x - anchoredWidth
      : anchor.x
  const anchoredTop =
    placement === 'below-end' || placement === 'left-start'
      ? Math.max(EDGE_GUTTER, Math.min(anchor.y, bounds.height - anchoredVisibleHeight - EDGE_GUTTER))
      : Math.max(EDGE_GUTTER, Math.min(anchor.y, bounds.height - Math.min(560, bounds.height - EDGE_GUTTER * 2) - EDGE_GUTTER))
  const anchoredMaxHeight =
    placement === 'below-end' || placement === 'left-start'
      ? Math.max(90, Math.min(620, bounds.height - anchoredTop - EDGE_GUTTER))
      : Math.min(560, bounds.height - EDGE_GUTTER * 2)
  const anchoredStyle: React.CSSProperties = {
    left: Math.max(EDGE_GUTTER, Math.min(anchoredLeft, bounds.width - anchoredWidth - EDGE_GUTTER)),
    top: anchoredTop,
    width: anchoredWidth,
    maxHeight: anchoredMaxHeight
  }

  let runningIndex = -1

  return (
    <div
      ref={rootRef}
      data-automation-interactive="true"
      className={cn(
        styles.bubble,
        variant === 'docked' && styles.bubbleDocked,
        placement === 'below-end' && styles.bubbleBelowEnd,
        placement === 'left-start' && styles.bubbleLeftStart
      )}
      style={variant === 'docked' ? dockedStyle : anchoredStyle}
      role="dialog"
      aria-label="Agregar paso"
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className={styles.bubbleHeader}>
        <div className={styles.bubbleTitle}>
          {kind === 'trigger' ? 'Agregar disparador' : 'Agregar paso'}
          <div className={styles.bubbleSubtitle}>
            {kind === 'trigger'
              ? 'Elige el evento que inicia la automatización'
              : 'Elige el siguiente paso del flujo'}
          </div>
        </div>
        <button type="button" className={styles.bubbleClose} onClick={onClose} title="Cerrar (Esc)">
          <X size={16} />
        </button>
      </div>

      <div className={styles.bubbleSearchRow}>
        <Search size={16} />
        <input
          data-ristak-unstyled
          ref={searchRef}
          className={styles.cleanSearchInput}
          style={{ flex: 1, minWidth: 0 }}
          placeholder={kind === 'trigger' ? 'Buscar disparador…' : 'Buscar paso…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Buscar paso"
        />
      </div>

      <div className={styles.bubbleBody}>
        {showStartStep && onSelectStartStep && !query && (
          <div className={styles.pickerSection} style={{ marginTop: 0 }}>
            <div className={styles.pickerSectionTitle}>Paso inicial</div>
            <button
              type="button"
              data-accent="green"
              className={styles.pickerItem}
              onClick={onSelectStartStep}
            >
              <span className={styles.pickerItemIcon}>
                <Play size={16} />
              </span>
              <span className={styles.pickerItemLabel}>
                Disparador
                <span className={styles.pickerItemDescription}>
                  Añade un evento que inicia la automatización
                </span>
              </span>
              <ChevronRight size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
            </button>
          </div>
        )}
        {sections.length === 0 && (
          <p className={styles.pickerEmpty}>No hay pasos que coincidan con "{query}"</p>
        )}
        {sections.map((section) => (
          <div key={section.id} className={styles.pickerSection}>
            <div className={styles.pickerSectionTitle}>{section.label}</div>
            {section.items.map((definition) => {
              runningIndex += 1
              const index = runningIndex
              return (
                <button
                  key={`${section.id}-${definition.type}`}
                  type="button"
                  data-picker-index={index}
                  data-accent={definition.accent}
                  className={cn(styles.pickerItem, index === activeIndex && styles.pickerItemActive)}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onSelect(definition)}
                >
                  <span className={styles.pickerItemIcon}>
                    <definition.icon size={16} />
                  </span>
                  <span className={styles.pickerItemLabel}>
                    {definition.label}
                    {definition.description && (
                      <span className={styles.pickerItemDescription}>{definition.description}</span>
                    )}
                  </span>
                  <ChevronRight size={15} style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {connectLabel && onToggleConnect && (
        <label className={styles.bubbleFooter} style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={Boolean(connectEnabled)}
            onChange={(event) => onToggleConnect(event.target.checked)}
          />
          <Link2 size={14} style={{ color: 'var(--color-text-tertiary)' }} />
          {connectLabel}
        </label>
      )}
    </div>
  )
}
