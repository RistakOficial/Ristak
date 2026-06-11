import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Lock, Plus, Search, X } from 'lucide-react'
import { contactTagsService, type ContactTag } from '@/services/contactTagsService'
import styles from './TagPicker.module.css'

/**
 * Selector de etiquetas de contactos con buscador y creación inline.
 * - multiple: chips removibles + dropdown para agregar (modal de contacto, bulk)
 * - single:   un solo valor (filtros de automatizaciones y agente conversacional)
 * Las etiquetas internas (Cliente, Cita agendada, Prospecto) solo aparecen
 * como opciones cuando includeSystem es true (filtros); nunca se pueden crear,
 * editar ni asignar manualmente.
 */

export function useContactTags() {
  const [tags, setTags] = useState<ContactTag[]>(() => contactTagsService.getCachedTags() || [])
  const [loading, setLoading] = useState(!contactTagsService.getCachedTags())

  useEffect(() => {
    const unsubscribe = contactTagsService.subscribe(setTags)
    contactTagsService.getTags().finally(() => setLoading(false))
    return unsubscribe
  }, [])

  return { tags, loading }
}

interface TagPickerBaseProps {
  /** Mostrar etiquetas internas del sistema como opciones (para filtros) */
  includeSystem?: boolean
  /** Permite crear etiquetas nuevas desde el propio buscador */
  allowCreate?: boolean
  placeholder?: string
  disabled?: boolean
  /** Dibuja el dropdown en un portal (paneles con scroll que recortan) */
  portal?: boolean
  'aria-label'?: string
}

interface TagPickerMultiProps extends TagPickerBaseProps {
  multiple: true
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** Chips fijos no removibles (p. ej. la etiqueta interna del contacto) */
  lockedTags?: Array<{ id: string; name: string }>
}

interface TagPickerSingleProps extends TagPickerBaseProps {
  multiple?: false
  value: string
  onValueChange: (id: string, name: string) => void
}

type TagPickerProps = TagPickerMultiProps | TagPickerSingleProps

const normalize = (value: string) =>
  value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()

export const TagPicker: React.FC<TagPickerProps> = (props) => {
  const {
    includeSystem = false,
    allowCreate = true,
    placeholder,
    disabled = false,
    portal = false
  } = props
  const isMultiple = props.multiple === true

  const { tags, loading } = useContactTags()
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const selectedIds = isMultiple ? (props as TagPickerMultiProps).selectedIds : []
  const singleValue = !isMultiple ? (props as TagPickerSingleProps).value : ''

  const availableTags = useMemo(
    () => tags.filter((tag) => includeSystem || !tag.isSystem),
    [tags, includeSystem]
  )

  const filteredTags = useMemo(() => {
    const query = normalize(search)
    const list = availableTags.filter((tag) => (isMultiple ? !selectedIds.includes(tag.id) : true))
    if (!query) return list
    return list.filter((tag) => normalize(tag.name).includes(query))
  }, [availableTags, search, isMultiple, selectedIds])

  const exactMatch = useMemo(() => {
    const query = normalize(search)
    if (!query) return true
    return tags.some((tag) => normalize(tag.name) === query)
  }, [tags, search])

  const canCreate = allowCreate && search.trim().length > 0 && !exactMatch && !creating

  const updatePortalPosition = useCallback(() => {
    if (!portal || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const viewportPadding = 8
    const estimatedHeight = 300
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
    const available = Math.max(140, openAbove ? spaceAbove : spaceBelow)
    const height = Math.min(estimatedHeight, available)
    setPortalStyle({
      position: 'fixed',
      top: openAbove ? Math.max(viewportPadding, rect.top - height - 4) : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      zIndex: 10000,
      '--tag-picker-options-max-height': `${height - 52}px`
    } as React.CSSProperties)
  }, [portal])

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!containerRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setIsOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    searchInputRef.current?.focus()
    if (!portal) return
    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)
    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [isOpen, portal, updatePortalPosition])

  const selectTag = (tag: ContactTag) => {
    if (isMultiple) {
      const multi = props as TagPickerMultiProps
      if (!multi.selectedIds.includes(tag.id)) {
        multi.onChange([...multi.selectedIds, tag.id])
      }
      setSearch('')
      searchInputRef.current?.focus()
    } else {
      const single = props as TagPickerSingleProps
      single.onValueChange(tag.id, tag.name)
      setIsOpen(false)
      setSearch('')
    }
  }

  const removeTag = (id: string) => {
    if (!isMultiple) return
    const multi = props as TagPickerMultiProps
    multi.onChange(multi.selectedIds.filter((value) => value !== id))
  }

  const createTag = async () => {
    const name = search.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const tag = await contactTagsService.createTag(name)
      selectTag({ ...tag, isSystem: false })
    } catch {
      // El catálogo mostrará el error en el siguiente intento; no rompemos el picker
    } finally {
      setCreating(false)
    }
  }

  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
  const lockedTags = isMultiple ? (props as TagPickerMultiProps).lockedTags || [] : []
  const singleSelected = !isMultiple ? tagById.get(singleValue) : undefined
  const singleLabel = singleSelected?.name || (singleValue ? singleValue : '')

  const dropdown = isOpen && !disabled ? (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${portal ? styles.portalDropdown : ''}`}
      style={portal ? portalStyle : undefined}
    >
      <div className={styles.searchWrap}>
        <Search size={14} />
        <input
          ref={searchInputRef}
          className={styles.searchInput}
          value={search}
          placeholder="Buscar etiqueta…"
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              if (filteredTags.length > 0) selectTag(filteredTags[0])
              else if (canCreate) createTag()
            }
            if (event.key === 'Escape') {
              setIsOpen(false)
              setSearch('')
            }
          }}
        />
      </div>
      <div className={styles.options}>
        {loading && tags.length === 0 ? (
          <div className={styles.empty}>Cargando etiquetas…</div>
        ) : (
          <>
            {filteredTags.map((tag) => {
              const isSelected = !isMultiple && tag.id === singleValue
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
                  onClick={() => selectTag(tag)}
                >
                  <span>{tag.name}</span>
                  {tag.isSystem ? (
                    <span className={styles.optionMeta}>interna</span>
                  ) : isSelected ? (
                    <Check size={14} className={styles.checkIcon} />
                  ) : null}
                </button>
              )
            })}
            {canCreate && (
              <button type="button" className={styles.createOption} onClick={createTag}>
                <span>
                  <Plus size={13} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  Crear etiqueta “{search.trim()}”
                </span>
              </button>
            )}
            {creating && <div className={styles.empty}>Creando etiqueta…</div>}
            {!creating && filteredTags.length === 0 && !canCreate && (
              <div className={styles.empty}>
                {search ? 'No hay etiquetas que coincidan' : 'No hay etiquetas disponibles'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  ) : null

  return (
    <div ref={containerRef} className={styles.container}>
      {isMultiple && (lockedTags.length > 0 || selectedIds.length > 0) && (
        <div className={styles.chips}>
          {lockedTags.map((tag) => (
            <span key={tag.id} className={`${styles.chip} ${styles.chipSystem}`} title="Etiqueta interna: se asigna sola según la actividad del contacto">
              <span className={styles.chipLock}><Lock size={11} /></span>
              <span className={styles.chipLabel}>{tag.name}</span>
            </span>
          ))}
          {selectedIds.map((id) => {
            const tag = tagById.get(id)
            return (
              <span key={id} className={styles.chip}>
                <span className={styles.chipLabel}>{tag?.name || id}</span>
                {!disabled && (
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => removeTag(id)}
                    aria-label={`Quitar etiqueta ${tag?.name || id}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}

      <button
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.open : ''}`}
        onClick={() => !disabled && setIsOpen((open) => !open)}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={props['aria-label']}
      >
        <span className={isMultiple || !singleLabel ? styles.triggerPlaceholder : styles.triggerLabel}>
          {isMultiple
            ? placeholder || 'Agregar etiqueta…'
            : singleLabel || placeholder || 'Selecciona una etiqueta'}
        </span>
        <ChevronDown size={16} className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`} />
      </button>

      {portal ? createPortal(dropdown, document.body) : dropdown}
    </div>
  )
}
