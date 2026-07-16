import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Search } from 'lucide-react'
import { getFloatingLayerZIndex } from '@/utils/layering'
import styles from './CustomSelect.module.css'

interface Option {
  value: string
  label: string
  disabled?: boolean
  icon?: React.ReactNode
}

interface OptionGroup {
  label: string
  options: Option[]
}

type OptionEntry = Option | OptionGroup

type CustomSelectChangeEvent = {
  target: {
    name?: string
    value: string
  }
  currentTarget: {
    name?: string
    value: string
  }
}

interface CustomSelectProps {
  options?: Option[]
  value?: string | number
  defaultValue?: string | number
  onChange?: (event: CustomSelectChangeEvent) => void
  onValueChange?: (value: string) => void
  onSearchChange?: (value: string) => void
  onOpenChange?: (open: boolean) => void
  onLoadMore?: () => void
  onBlur?: React.FocusEventHandler<HTMLButtonElement>
  placeholder?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  portal?: boolean
  dropdownPlacement?: 'auto' | 'top' | 'bottom'
  dropdownMinWidth?: number
  dropdownMinHeight?: number
  iconOnly?: boolean
  placeholderIcon?: React.ReactNode
  size?: 'default' | 'large'
  name?: string
  id?: string
  required?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  emptyMessage?: string
  hasMore?: boolean
  loading?: boolean
  selectedContent?: React.ReactNode
  children?: React.ReactNode
  'aria-label'?: string
  'aria-labelledby'?: string
}

const isOptionGroup = (entry: OptionEntry): entry is OptionGroup => 'options' in entry

type OptionElementProps = {
  value?: string | number
  disabled?: boolean
  label?: string
  children?: React.ReactNode
}

const getTextFromReactNode = (node: React.ReactNode): string => {
  return React.Children.toArray(node)
    .map(child => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
        return getTextFromReactNode(child.props.children)
      }
      return ''
    })
    .join('')
    .trim()
}

const parseOptionChildren = (children: React.ReactNode): OptionEntry[] => {
  return React.Children.toArray(children).flatMap((child): OptionEntry[] => {
    if (!React.isValidElement<OptionElementProps>(child)) return []

    if (child.type === React.Fragment) {
      return parseOptionChildren(child.props.children)
    }

    if (child.type === 'optgroup') {
      return [{
        label: String(child.props.label || ''),
        options: parseOptionChildren(child.props.children).flatMap(entry => isOptionGroup(entry) ? entry.options : [entry])
      }]
    }

    if (child.type === 'option') {
      const label = getTextFromReactNode(child.props.children)
      return [{
        value: String(child.props.value ?? label),
        label,
        disabled: Boolean(child.props.disabled)
      }]
    }

    return []
  })
}

const flattenOptions = (entries: OptionEntry[]) =>
  entries.flatMap(entry => isOptionGroup(entry) ? entry.options : [entry])

export const CustomSelect: React.FC<CustomSelectProps> = ({
  options,
  value,
  defaultValue,
  onChange,
  onValueChange,
  onSearchChange,
  onOpenChange,
  onLoadMore,
  onBlur,
  placeholder = 'Selecciona una opción',
  disabled = false,
  className = '',
  style,
  portal = true,
  dropdownPlacement = 'auto',
  dropdownMinWidth,
  dropdownMinHeight,
  iconOnly = false,
  placeholderIcon,
  size = 'default',
  name,
  id,
  required,
  searchable = false,
  searchPlaceholder = 'Buscar…',
  emptyMessage = 'No hay resultados',
  hasMore = false,
  loading = false,
  selectedContent,
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({})
  const [portalPlacement, setPortalPlacement] = useState<'top' | 'bottom'>('bottom')
  const [searchQuery, setSearchQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const shouldPortal = portal && typeof document !== 'undefined'

  const updateSearchQuery = useCallback((nextQuery: string) => {
    setSearchQuery(nextQuery)
    onSearchChange?.(nextQuery)
  }, [onSearchChange])

  const closeDropdown = useCallback(() => {
    setIsOpen(false)
    onOpenChange?.(false)
    updateSearchQuery('')
  }, [onOpenChange, updateSearchQuery])

  const optionEntries = useMemo<OptionEntry[]>(() => {
    if (options) return options.map(option => ({ ...option, value: String(option.value) }))
    return parseOptionChildren(children)
  }, [children, options])
  const flatOptions = useMemo(() => flattenOptions(optionEntries), [optionEntries])
  const filteredOptionEntries = useMemo<OptionEntry[]>(() => {
    const query = searchQuery
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
    if (!searchable || !query) return optionEntries
    const matches = (option: Option) => option.label
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .includes(query)
    const filteredEntries: OptionEntry[] = []
    for (const entry of optionEntries) {
      if (!isOptionGroup(entry)) {
        if (matches(entry)) filteredEntries.push(entry)
        continue
      }
      const filtered = entry.options.filter(matches)
      if (filtered.length) filteredEntries.push({ ...entry, options: filtered })
    }
    return filteredEntries
  }, [optionEntries, searchQuery, searchable])
  const filteredFlatOptions = useMemo(() => flattenOptions(filteredOptionEntries), [filteredOptionEntries])
  const firstEnabledOption = flatOptions.find(option => !option.disabled)
  const isControlled = value !== undefined
  const [internalValue, setInternalValue] = useState(() => String(defaultValue ?? value ?? firstEnabledOption?.value ?? ''))
  const selectedValue = String(isControlled ? value : internalValue)
  const selectedOption = flatOptions.find(opt => opt.value === selectedValue)

  useEffect(() => {
    if (isControlled || internalValue || defaultValue !== undefined || !firstEnabledOption) return
    setInternalValue(firstEnabledOption.value)
  }, [defaultValue, firstEnabledOption, internalValue, isControlled])

  const updatePortalPosition = useCallback(() => {
    if (!shouldPortal || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const viewportPadding = 12
    const dropdownGap = 6
    const rowHeight = size === 'large' ? 42 : 40
    const groupLabelHeight = size === 'large' ? 34 : 28
    const searchHeight = searchable ? 45 : 0
    const maxDropdownHeight = size === 'large' ? 420 : 280
    const viewportMinHeight = size === 'large' ? 220 : 120
    const dropdownWidth = dropdownMinWidth ? Math.max(rect.width, dropdownMinWidth) : rect.width
    const optionGroupCount = optionEntries.filter(isOptionGroup).length
    const estimatedContentHeight = flatOptions.length * rowHeight + optionGroupCount * groupLabelHeight + searchHeight + 8
    const estimatedHeight = Math.min(
      Math.max(estimatedContentHeight, dropdownMinHeight || 0),
      maxDropdownHeight
    )
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openAbove = dropdownPlacement === 'top' ||
      (dropdownPlacement === 'auto' && spaceBelow < estimatedHeight && spaceAbove > spaceBelow)
    const availableSpace = Math.max(viewportMinHeight, openAbove ? spaceAbove : spaceBelow)
    const dropdownHeight = Math.min(estimatedHeight, availableSpace)
    setPortalPlacement(openAbove ? 'top' : 'bottom')

    setPortalStyle({
      position: 'fixed',
      top: openAbove
        ? Math.max(viewportPadding, rect.top - dropdownHeight - dropdownGap)
        : Math.min(rect.bottom + dropdownGap, window.innerHeight - viewportPadding - dropdownHeight),
      left: Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - dropdownWidth - viewportPadding),
      width: dropdownWidth,
      zIndex: getFloatingLayerZIndex(containerRef.current, 'popover'),
      '--custom-select-options-max-height': `${Math.max(80, dropdownHeight - searchHeight)}px`,
      ...(dropdownMinHeight ? { '--custom-select-options-min-height': `${Math.max(80, dropdownHeight - searchHeight)}px` } : {})
    } as React.CSSProperties)
  }, [dropdownMinHeight, dropdownMinWidth, dropdownPlacement, flatOptions.length, optionEntries, searchable, shouldPortal, size])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedContainer = containerRef.current?.contains(target)
      const clickedDropdown = dropdownRef.current?.contains(target)

      if (!clickedContainer && !clickedDropdown) {
        closeDropdown()
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [closeDropdown, isOpen])

  useEffect(() => {
    if (!isOpen || !searchable) return
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [isOpen, searchable])

  useEffect(() => {
    if (!isOpen || !shouldPortal) return

    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)

    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [isOpen, shouldPortal, updatePortalPosition])

  const handleSelect = (option: Option) => {
    if (option.disabled) return

    const optionValue = option.value
    if (!isControlled) {
      setInternalValue(optionValue)
    }
    onValueChange?.(optionValue)

    const changeEvent: CustomSelectChangeEvent = {
      target: { name, value: optionValue },
      currentTarget: { name, value: optionValue }
    }
    onChange?.(changeEvent)

    if (!isControlled && changeEvent.currentTarget.value !== optionValue) {
      setInternalValue(changeEvent.currentTarget.value)
    }
    closeDropdown()
  }

  const dropdown = isOpen && !disabled ? (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${shouldPortal ? styles.portalDropdown : ''} ${size === 'large' ? styles.dropdownLarge : ''}`}
      style={shouldPortal ? portalStyle : undefined}
      data-placement={shouldPortal ? portalPlacement : undefined}
      data-ristak-dropdown-panel
    >
      {searchable ? (
        <div className={styles.searchWrap}>
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            data-ristak-unstyled
            className={styles.searchInput}
            value={searchQuery}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onChange={(event) => updateSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const firstMatch = filteredFlatOptions.find(option => !option.disabled)
                if (firstMatch) {
                  event.preventDefault()
                  handleSelect(firstMatch)
                }
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                closeDropdown()
              }
            }}
          />
        </div>
      ) : null}
      <div className={styles.options}>
        {filteredOptionEntries.map((entry) => {
          if (isOptionGroup(entry)) {
            return (
              <div key={`group-${entry.label}`} className={styles.optionGroup}>
                <div className={styles.optionGroupLabel}>{entry.label}</div>
                {entry.options.map((option) => {
                  const isSelected = option.value === selectedValue
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
                      onClick={() => handleSelect(option)}
                      disabled={option.disabled}
                      data-ristak-dropdown-item
                      data-selected={isSelected ? 'true' : undefined}
                    >
                      <span>{option.label}</span>
                      {isSelected && <Check size={16} className={styles.checkIcon} />}
                    </button>
                  )
                })}
              </div>
            )
          }

          const isSelected = entry.value === selectedValue
          return (
            <button
              key={entry.value}
              type="button"
              className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
              onClick={() => handleSelect(entry)}
              disabled={entry.disabled}
              data-ristak-dropdown-item
              data-selected={isSelected ? 'true' : undefined}
            >
              <span>{entry.label}</span>
              {isSelected && <Check size={16} className={styles.checkIcon} />}
            </button>
          )
        })}
        {filteredFlatOptions.length === 0 ? (
          <div className={styles.empty} role="status">{loading ? 'Cargando opciones…' : emptyMessage}</div>
        ) : null}
        {hasMore && onLoadMore ? (
          <button
            type="button"
            className={styles.option}
            onClick={onLoadMore}
            disabled={loading}
            data-ristak-dropdown-item
          >
            <span>{loading ? 'Cargando…' : 'Cargar más'}</span>
          </button>
        ) : null}
      </div>
    </div>
  ) : null
  const selectedIcon = selectedOption?.icon
  const triggerIcon = selectedIcon || placeholderIcon

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${size === 'large' ? styles.large : ''} ${className} ${disabled ? styles.disabled : ''}`}
      style={style}
    >
      <button
        id={id}
        type="button"
        className={`${styles.trigger} ${iconOnly ? styles.iconOnlyTrigger : ''} ${isOpen ? styles.open : ''}`}
        onClick={() => {
          if (disabled) return
          if (isOpen) {
            closeDropdown()
            return
          }
          setIsOpen(true)
          onOpenChange?.(true)
        }}
        onBlur={onBlur}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel || selectedOption?.label || placeholder}
        aria-labelledby={ariaLabelledBy}
        title={iconOnly ? selectedOption?.label || placeholder : undefined}
        data-ristak-dropdown-trigger
      >
        <span className={selectedOption ? styles.selected : styles.placeholder}>
          {iconOnly && triggerIcon ? (
            <>
              <span className={styles.triggerIcon} aria-hidden="true">{triggerIcon}</span>
              <span className={styles.srOnly}>{selectedOption?.label || placeholder}</span>
            </>
          ) : selectedOption && selectedContent ? selectedContent : selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
        />
      </button>
      {name && (
        <input
          type="hidden"
          name={name}
          value={selectedValue}
          required={required}
          disabled={disabled}
        />
      )}

      {shouldPortal ? createPortal(dropdown, document.body) : dropdown}
    </div>
  )
}
