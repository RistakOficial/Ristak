import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import styles from './CustomSelect.module.css'

interface Option {
  value: string
  label: string
}

interface CustomSelectProps {
  options: Option[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  portal?: boolean
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Selecciona una opción',
  disabled = false,
  className = '',
  portal = false
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties>({})
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(opt => opt.value === value)

  const updatePortalPosition = useCallback(() => {
    if (!portal || !containerRef.current) return

    const rect = containerRef.current.getBoundingClientRect()
    const viewportPadding = 8
    const dropdownGap = 4
    const estimatedHeight = Math.min(options.length * 44 + 8, 280)
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding
    const spaceAbove = rect.top - viewportPadding
    const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow
    const availableSpace = Math.max(120, openAbove ? spaceAbove : spaceBelow)
    const dropdownHeight = Math.min(estimatedHeight, availableSpace)

    setPortalStyle({
      position: 'fixed',
      top: openAbove
        ? Math.max(viewportPadding, rect.top - dropdownHeight - dropdownGap)
        : Math.min(rect.bottom + dropdownGap, window.innerHeight - viewportPadding - dropdownHeight),
      left: rect.left,
      width: rect.width,
      zIndex: 10000,
      '--custom-select-options-max-height': `${dropdownHeight}px`
    } as React.CSSProperties)
  }, [options.length, portal])

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
    if (!isOpen || !portal) return

    updatePortalPosition()
    window.addEventListener('resize', updatePortalPosition)
    window.addEventListener('scroll', updatePortalPosition, true)

    return () => {
      window.removeEventListener('resize', updatePortalPosition)
      window.removeEventListener('scroll', updatePortalPosition, true)
    }
  }, [isOpen, portal, updatePortalPosition])

  const handleSelect = (optionValue: string) => {
    onChange(optionValue)
    setIsOpen(false)
  }

  const dropdown = isOpen && !disabled ? (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${portal ? styles.portalDropdown : ''}`}
      style={portal ? portalStyle : undefined}
      data-ristak-dropdown-panel
    >
      <div className={styles.options}>
        {options.map((option) => {
          const isSelected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              className={`${styles.option} ${isSelected ? styles.optionSelected : ''}`}
              onClick={() => handleSelect(option.value)}
              data-ristak-dropdown-item
              data-selected={isSelected ? 'true' : undefined}
            >
              <span>{option.label}</span>
              {isSelected && <Check size={16} className={styles.checkIcon} />}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${className} ${disabled ? styles.disabled : ''}`}
    >
      <button
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.open : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-expanded={isOpen}
        data-ristak-dropdown-trigger
      >
        <span className={selectedOption ? styles.selected : styles.placeholder}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}
        />
      </button>

      {portal ? createPortal(dropdown, document.body) : dropdown}
    </div>
  )
}
