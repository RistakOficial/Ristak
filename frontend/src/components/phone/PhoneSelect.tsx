import React, { useEffect, useMemo, useRef, useState } from 'react'
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
  inlineOnWide?: boolean
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
  ariaLabel,
  inlineOnWide = false
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [wideViewport, setWideViewport] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : false
  ))
  const selectedOption = useMemo(() => options.find((option) => option.value === value), [options, value])
  const useInlinePanel = inlineOnWide && wideViewport

  const handleSelect = (option: PhoneSelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia('(min-width: 768px)')
    const update = () => setWideViewport(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!open || !useInlinePanel) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && hostRef.current?.contains(target)) return
      setOpen(false)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, useInlinePanel])

  const optionsList = (
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
  )

  return (
    <div ref={hostRef} className={`${styles.host} ${useInlinePanel ? styles.hostInline : ''} ${className}`}>
      <button
        type="button"
        className={`${styles.trigger} ${invalid ? styles.invalid : ''} ${buttonClassName}`}
        disabled={disabled}
        aria-label={ariaLabel || title}
        aria-haspopup={useInlinePanel ? 'listbox' : 'dialog'}
        aria-expanded={open}
        onClick={() => !disabled && setOpen((current) => !current)}
      >
        <span className={selectedOption ? styles.value : styles.placeholder}>
          {selectedOption?.label || placeholder}
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>

      {useInlinePanel ? (
        open && (
          <div className={styles.popoverPanel}>
            {optionsList}
          </div>
        )
      ) : (
        <PhoneSheet
          isOpen={open}
          onClose={() => setOpen(false)}
          title={title}
          ariaLabel={ariaLabel || title}
          panelClassName={sheetClassName}
        >
          {optionsList}
        </PhoneSheet>
      )}
    </div>
  )
}
