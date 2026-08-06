import React from 'react'
import { cn } from '@/utils/cn'
import styles from './SelectionGrid.module.css'

export interface SelectionGridDetail {
  label: string
  value: React.ReactNode
}

export interface SelectionGridOption {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  status?: React.ReactNode
  details?: SelectionGridDetail[]
  footer?: React.ReactNode
  disabled?: boolean
  disabledReason?: string | null
}

export interface SelectionGridProps {
  options: SelectionGridOption[]
  value?: string | null
  onChange: (id: string) => void
  ariaLabel: string
  className?: string
}

/** Selector accesible de opciones ricas. Usa radios reales y el vocabulario de
 * superficies/tokens globales para catálogos de planes, capacidad o variantes. */
export const SelectionGrid: React.FC<SelectionGridProps> = ({
  options,
  value,
  onChange,
  ariaLabel,
  className
}) => (
  <div className={cn(styles.grid, className)} role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => {
      const selected = value === option.id
      return (
        <label
          key={option.id}
          className={styles.option}
          data-selected={selected ? 'true' : undefined}
          data-disabled={option.disabled ? 'true' : undefined}
          title={option.disabledReason || undefined}
        >
          <input
            className={styles.input}
            type="radio"
            name={ariaLabel}
            value={option.id}
            checked={selected}
            disabled={option.disabled}
            onChange={() => onChange(option.id)}
          />
          <span className={styles.marker} aria-hidden="true" />
          <span className={styles.content}>
            <span className={styles.heading}>
              <span className={styles.title}>{option.title}</span>
              {option.status && <span className={styles.status}>{option.status}</span>}
            </span>
            {option.description && <span className={styles.description}>{option.description}</span>}
            {option.details?.length ? (
              <span className={styles.details}>
                {option.details.map((detail) => (
                  <span className={styles.detail} key={detail.label}>
                    <span>{detail.label}</span>
                    <strong>{detail.value}</strong>
                  </span>
                ))}
              </span>
            ) : null}
            {option.footer && <span className={styles.footer}>{option.footer}</span>}
            {option.disabledReason && <span className={styles.reason}>{option.disabledReason}</span>}
          </span>
        </label>
      )
    })}
  </div>
)
