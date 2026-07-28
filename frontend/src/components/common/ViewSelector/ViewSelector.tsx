import React, { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../DropdownMenu'
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
  const selectedOption = options.find(opt => opt.value === value)

  const handleSelect = (optionValue: string) => {
    onChange(optionValue)
  }

  const isTitle = variant === 'title'

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <div className={`${styles.wrapper} ${isTitle ? styles.wrapperTitle : ''} ${className || ''}`}>
        <DropdownMenuTrigger asChild>
          <button
            className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ''} ${isTitle ? styles.triggerTitle : ''}`}
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
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align={isTitle ? 'start' : 'end'}
          sideOffset={4}
          className={`${styles.dropdown} ${isTitle ? styles.dropdownTitle : ''}`}
        >
          {options.map(option => (
            <DropdownMenuItem
              key={option.value}
              className={`${styles.option} ${option.value === value ? styles.optionActive : ''}`}
              onSelect={() => handleSelect(option.value)}
              data-selected={option.value === value ? 'true' : undefined}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={15} aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}
