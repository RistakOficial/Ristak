import React, { useMemo, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { PhoneSheet } from './ui/PhoneSheet'
import styles from './PhoneSelect.module.css'

export interface PhoneSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface PhoneSelectProps {
  options: PhoneSelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  title?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
  buttonClassName?: string
  sheetClassName?: string
  ariaLabel?: string
}

export const PhoneSelect: React.FC<PhoneSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'Selecciona una opción',
  title = 'Selecciona',
  disabled = false,
  invalid = false,
  className = '',
  buttonClassName = '',
  sheetClassName = '',
  ariaLabel
}) => {
  const [open, setOpen] = useState(false)
  const selectedOption = useMemo(() => options.find((option) => option.value === value), [options, value])

  const handleSelect = (option: PhoneSelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  return (
    <div className={`${styles.host} ${className}`}>
      <button
        type="button"
        className={`${styles.trigger} ${invalid ? styles.invalid : ''} ${buttonClassName}`}
        disabled={disabled}
        aria-label={ariaLabel || title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => !disabled && setOpen(true)}
      >
        <span className={selectedOption ? styles.value : styles.placeholder}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>

      <PhoneSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        title={title}
        ariaLabel={ariaLabel || title}
        panelClassName={sheetClassName}
      >
        <div className={styles.options} role="listbox" aria-label={title}>
          {options.map((option) => {
            const selected = option.value === value

            return (
              <button
                key={option.value}
                type="button"
                className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => handleSelect(option)}
              >
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
                {selected && <Check size={18} />}
              </button>
            )
          })}
        </div>
      </PhoneSheet>
    </div>
  )
}
