import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
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
  size?: 'default' | 'large'
  name?: string
  id?: string
  required?: boolean
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
  size = 'default',
  name,
  id,
  required,
  children,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({})
  const [portalPlacement, setPortalPlacement] = useState<'top' | 'bottom'>('bottom')
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const shouldPortal = portal && typeof document !== 'undefined'

  const optionEntries = useMemo<OptionEntry[]>(() => {
    if (options) return options.map(option => ({ ...option, value: String(option.value) }))
    return parseOptionChildren(children)
  }, [children, options])
  const flatOptions = useMemo(() => flattenOptions(optionEntries), [optionEntries])
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
    const maxDropdownHeight = size === 'large' ? 420 : 280
    const viewportMinHeight = size === 'large' ? 220 : 120
    const dropdownWidth = dropdownMinWidth ? Math.max(rect.width, dropdownMinWidth) : rect.width
    const optionGroupCount = optionEntries.filter(isOptionGroup).length
    const estimatedContentHeight = flatOptions.length * rowHeight + optionGroupCount * groupLabelHeight + 8
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
      '--custom-select-options-max-height': `${dropdownHeight}px`,
      ...(dropdownMinHeight ? { '--custom-select-options-min-height': `${dropdownHeight}px` } : {})
    } as React.CSSProperties)
  }, [dropdownMinHeight, dropdownMinWidth, dropdownPlacement, flatOptions.length, optionEntries, shouldPortal, size])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const clickedContainer = containerRef.current?.contains(target)
      const clickedDropdown = dropdownRef.current?.contains(target)

      if (!clickedContainer && !clickedDropdown) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

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
    setIsOpen(false)
  }

  const dropdown = isOpen && !disabled ? (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${shouldPortal ? styles.portalDropdown : ''} ${size === 'large' ? styles.dropdownLarge : ''}`}
      style={shouldPortal ? portalStyle : undefined}
      data-placement={shouldPortal ? portalPlacement : undefined}
      data-ristak-dropdown-panel
    >
      <div className={styles.options}>
        {optionEntries.map((entry) => {
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
      </div>
    </div>
  ) : null
  const selectedIcon = selectedOption?.icon

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
        onClick={() => !disabled && setIsOpen(!isOpen)}
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
          {iconOnly && selectedIcon ? (
            <>
              <span className={styles.triggerIcon} aria-hidden="true">{selectedIcon}</span>
              <span className={styles.srOnly}>{selectedOption?.label || placeholder}</span>
            </>
          ) : selectedOption?.label || placeholder}
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
