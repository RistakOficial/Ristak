import React from 'react'
import { ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '../DropdownMenu'
import styles from './CheckboxMultiSelect.module.css'

export interface CheckboxMultiSelectOption<T extends string = string> {
  value: T
  label: string
}

export interface CheckboxMultiSelectProps<T extends string = string> {
  options: Array<CheckboxMultiSelectOption<T>>
  value: T[]
  onChange: (value: T[]) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function CheckboxMultiSelect<T extends string = string>({
  options,
  value,
  onChange,
  placeholder = 'Ninguno',
  disabled = false,
  className = '',
  'aria-label': ariaLabel
}: CheckboxMultiSelectProps<T>) {
  const selected = new Set(value)
  const selectedLabels = options.filter((option) => selected.has(option.value)).map((option) => option.label)
  const summary = selectedLabels.length === 0
    ? placeholder
    : (selectedLabels.length <= 2 ? selectedLabels.join(', ') : `${selectedLabels.length} seleccionados`)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={`${styles.trigger} ${selectedLabels.length === 0 ? styles.placeholder : ''} ${className}`}
          aria-label={ariaLabel || placeholder}
          disabled={disabled}
        >
          <span>{summary}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={styles.content}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.has(option.value)}
            onCheckedChange={(checked) => {
              const next = checked
                ? options.filter((item) => selected.has(item.value) || item.value === option.value).map((item) => item.value)
                : value.filter((item) => item !== option.value)
              onChange(next)
            }}
            onSelect={(event) => event.preventDefault()}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
