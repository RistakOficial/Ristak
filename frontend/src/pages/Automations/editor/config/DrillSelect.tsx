import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAnchoredPortal } from '@/hooks/useAnchoredPortal'
import styles from '../AutomationEditor.module.css'

/**
 * Selector con categorías tipo Finder: primero la lista de categorías
 * (como carpetas), al hacer clic se entra a sus opciones con flecha para
 * volver. El buscador busca en todas las categorías a la vez.
 */

export interface DrillGroup {
  id: string
  label: string
  items: Array<{ value: string; label: string }>
}

interface DrillSelectProps {
  groups: DrillGroup[]
  value: string
  onValueChange: (value: string, label: string) => void
  placeholder?: string
  'aria-label'?: string
}

export const DrillSelect: React.FC<DrillSelectProps> = ({
  groups,
  value,
  onValueChange,
  placeholder = 'Selecciona una opción',
  ...rest
}) => {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [groupId, setGroupId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const {
    style: position,
    placement: dropdownPlacement
  } = useAnchoredPortal(triggerRef, open, {
    gap: 6,
    minWidth: 360,
    maxHeight: 420,
    panelRef: dropdownRef
  })

  const visibleGroups = groups.filter((group) => group.items.length > 0)
  const selected = visibleGroups.flatMap((group) => group.items).find((item) => item.value === value)
  const activeGroup = visibleGroups.find((group) => group.id === groupId) || null
  const searching = query.trim().length > 0

  const openDropdown = () => {
    // Abre directamente en la categoría del valor actual si existe
    const owner = value ? visibleGroups.find((group) => group.items.some((item) => item.value === value)) : null
    setGroupId(owner ? owner.id : null)
    setQuery('')
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (dropdownRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (item: { value: string; label: string }) => {
    onValueChange(item.value, item.label)
    setOpen(false)
  }

  const matches = searching
    ? visibleGroups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))
        }))
        .filter((group) => group.items.length > 0)
    : []

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.drillTrigger}
        onClick={() => (open ? setOpen(false) : openDropdown())}
        aria-label={rest['aria-label']}
        data-automation-interactive="true"
      >
        <span className={cn(styles.drillTriggerText, !selected && styles.drillTriggerPlaceholder)}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={13} />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className={styles.drillDropdown}
            style={position}
            data-placement={dropdownPlacement}
            data-ristak-dropdown-panel
            data-automation-interactive="true"
          >
            <div className={styles.drillSearch}>
              <Search size={12} />
              <input
                data-ristak-unstyled
                className={styles.cleanSearchInput}
                placeholder="Buscar en todas las categorías"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoFocus
              />
            </div>

            <div className={styles.drillList}>
              {searching ? (
                matches.length === 0 ? (
                  <div className={styles.drillEmpty}>Sin resultados</div>
                ) : (
                  matches.map((group) => (
                    <React.Fragment key={group.id}>
                      <div className={styles.drillGroupLabel}>{group.label}</div>
                      {group.items.map((item) => (
                        <button key={item.value} type="button" className={styles.drillItem} onClick={() => pick(item)}>
                          <span className={styles.drillItemLabel}>{item.label}</span>
                          {item.value === value && <Check size={12} />}
                        </button>
                      ))}
                    </React.Fragment>
                  ))
                )
              ) : activeGroup ? (
                <>
                  <button type="button" className={styles.drillBack} onClick={() => setGroupId(null)}>
                    <ArrowLeft size={12} />
                    {activeGroup.label}
                  </button>
                  {activeGroup.items.map((item) => (
                    <button key={item.value} type="button" className={styles.drillItem} onClick={() => pick(item)}>
                      <span className={styles.drillItemLabel}>{item.label}</span>
                      {item.value === value && <Check size={12} />}
                    </button>
                  ))}
                </>
              ) : (
                visibleGroups.map((group) => (
                  <button key={group.id} type="button" className={styles.drillItem} onClick={() => setGroupId(group.id)}>
                    <span className={styles.drillItemLabel}>{group.label}</span>
                    <span className={styles.drillItemCount}>{group.items.length}</span>
                    <ChevronRight size={12} />
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
