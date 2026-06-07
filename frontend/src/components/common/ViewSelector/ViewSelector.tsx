import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import styles from './ViewSelector.module.css'

interface ViewSelectorProps {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  className?: string
  /** 'control' (caja normal) o 'title' (se ve como un título grande con chevron). */
  variant?: 'control' | 'title'
}

export const ViewSelector: React.FC<ViewSelectorProps> = ({
  value,
  options,
  onChange,
  className,
  variant = 'control'
}) => {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(opt => opt.value === value)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
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

  const handleSelect = (optionValue: string) => {
    onChange(optionValue)
    setIsOpen(false)
  }

  const isTitle = variant === 'title'

  return (
    <div className={`${styles.wrapper} ${isTitle ? styles.wrapperTitle : ''} ${className || ''}`} ref={dropdownRef}>
      <button
        className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ''} ${isTitle ? styles.triggerTitle : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
        aria-expanded={isOpen}
        data-ristak-dropdown-trigger={isTitle ? undefined : 'true'}
      >
        <span className={styles.value}>{selectedOption?.label}</span>
        <ChevronDown
          size={isTitle ? 20 : 16}
          className={`${styles.icon} ${isOpen ? styles.iconOpen : ''}`}
        />
      </button>

      {isOpen && (
        <div className={`${styles.dropdown} ${isTitle ? styles.dropdownTitle : ''}`} data-ristak-dropdown-panel={isTitle ? undefined : 'true'}>
          {options.map(option => (
            <button
              key={option.value}
              className={`${styles.option} ${option.value === value ? styles.optionActive : ''}`}
              onClick={() => handleSelect(option.value)}
              type="button"
              data-ristak-dropdown-item={isTitle ? undefined : 'true'}
              data-selected={option.value === value ? 'true' : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
