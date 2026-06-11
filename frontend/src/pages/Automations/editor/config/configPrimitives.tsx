import React, { useEffect, useState } from 'react'
import { cn } from '@/utils/cn'
import { CustomSelect } from '@/components/common'
import { getCatalog, type CatalogKind, type CatalogOption } from '@/services/automationCatalogsService'
import { CONTACT_VARIABLES } from '../nodeRegistry'
import styles from '../AutomationEditor.module.css'

/**
 * Primitivas compartidas de los formularios de configuración de nodos.
 * Mantienen el mismo lenguaje visual en el formulario genérico y en los
 * configuradores avanzados (Condición, Esperar, Objetivo, WhatsApp).
 */

export const Field: React.FC<{ label?: string; help?: string; children: React.ReactNode }> = ({
  label,
  help,
  children
}) => (
  <div className={styles.configField}>
    {label && <label className={styles.configLabel}>{label}</label>}
    {children}
    {help && <span className={styles.configHelp}>{help}</span>}
  </div>
)

export const TextInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...props }) => (
  <input className={cn(styles.configInput, className)} {...props} />
)

export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className, ...props }) => (
  <textarea className={cn(styles.configTextarea, className)} rows={4} {...props} />
)

export const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string }> = ({
  checked,
  onChange,
  label
}) => (
  // Switch alineado a la izquierda con el texto a su derecha
  <div className={cn(styles.configField, styles.toggleField)}>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cn(styles.toggleSwitch, checked && styles.toggleSwitchOn)}
      onClick={() => onChange(!checked)}
    />
    <label className={styles.toggleLabel} onClick={() => onChange(!checked)}>
      {label}
    </label>
  </div>
)

export const VariableChips: React.FC<{ onInsert: (variable: string) => void }> = ({ onInsert }) => (
  <div className={styles.variableChips}>
    {CONTACT_VARIABLES.map((variable) => (
      <button
        key={variable}
        type="button"
        className={styles.variableChip}
        title={`Insertar ${variable}`}
        onClick={() => onInsert(variable)}
      >
        {variable}
      </button>
    ))}
  </div>
)

// ---------------------------------------------------------------------------
// Selects con catálogos CRM (etiquetas, calendarios, números de WhatsApp…)
// ---------------------------------------------------------------------------

export function useCatalogOptions(kind: CatalogKind | undefined): {
  options: CatalogOption[]
  loading: boolean
} {
  const [options, setOptions] = useState<CatalogOption[]>([])
  const [loading, setLoading] = useState(Boolean(kind))

  useEffect(() => {
    if (!kind) return
    let cancelled = false
    setLoading(true)
    getCatalog(kind).then((loaded) => {
      if (cancelled) return
      setOptions(loaded)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [kind])

  return { options, loading }
}

interface CatalogSelectProps {
  catalog: CatalogKind
  value: string
  placeholder?: string
  'aria-label'?: string
  /** Recibe el valor y la etiqueta legible de la opción elegida */
  onChange: (value: string, label: string) => void
}

export const CatalogSelect: React.FC<CatalogSelectProps> = ({
  catalog,
  value,
  placeholder,
  onChange,
  ...rest
}) => {
  const { options, loading } = useCatalogOptions(catalog)

  if (loading) {
    return <span className={styles.configHelp}>Cargando opciones…</span>
  }

  if (options.length === 0) {
    return <span className={styles.configHelp}>No hay opciones disponibles todavía.</span>
  }

  return (
    <CustomSelect
      options={options.map((option) => ({
        value: option.value,
        label: option.meta ? `${option.label} · ${option.meta}` : option.label
      }))}
      value={value}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next)
        onChange(next, selected?.label || next)
      }}
      placeholder={placeholder || 'Selecciona una opción'}
      aria-label={rest['aria-label']}
    />
  )
}

/** Chips multi-selección desde un catálogo (p. ej. etiquetas iniciales) */
export const CatalogTags: React.FC<{
  catalog: CatalogKind
  values: string[]
  onChange: (values: string[]) => void
  'aria-label'?: string
}> = ({ catalog, values, onChange, ...rest }) => {
  const { options, loading } = useCatalogOptions(catalog)
  const remaining = options.filter((option) => !values.includes(option.value))

  return (
    <div>
      {values.length > 0 && (
        <div className={styles.keywordChips} style={{ marginBottom: 6 }}>
          {values.map((value) => {
            const option = options.find((candidate) => candidate.value === value)
            return (
              <span key={value} className={styles.keywordChip}>
                {option?.label || value}
                <button
                  type="button"
                  className={styles.keywordChipRemove}
                  title="Quitar"
                  onClick={() => onChange(values.filter((candidate) => candidate !== value))}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}
      {loading ? (
        <span className={styles.configHelp}>Cargando opciones…</span>
      ) : remaining.length > 0 ? (
        <CustomSelect
          options={remaining.map((option) => ({ value: option.value, label: option.label }))}
          value=""
          onValueChange={(next) => onChange([...values, next])}
          placeholder="Agregar…"
          aria-label={rest['aria-label']}
        />
      ) : (
        values.length === 0 && <span className={styles.configHelp}>No hay opciones disponibles.</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Días de la semana y duraciones
// ---------------------------------------------------------------------------

const WEEKDAYS: Array<{ value: string; label: string }> = [
  { value: 'mon', label: 'L' },
  { value: 'tue', label: 'M' },
  { value: 'wed', label: 'X' },
  { value: 'thu', label: 'J' },
  { value: 'fri', label: 'V' },
  { value: 'sat', label: 'S' },
  { value: 'sun', label: 'D' }
]

export const WeekdaysPicker: React.FC<{ values: string[]; onChange: (values: string[]) => void }> = ({
  values,
  onChange
}) => (
  <div className={styles.weekdayRow}>
    {WEEKDAYS.map((day) => {
      const active = values.includes(day.value)
      return (
        <button
          key={day.value}
          type="button"
          className={cn(styles.weekdayButton, active && styles.weekdayButtonActive)}
          aria-pressed={active}
          title={day.value}
          onClick={() =>
            onChange(active ? values.filter((value) => value !== day.value) : [...values, day.value])
          }
        >
          {day.label}
        </button>
      )
    })}
  </div>
)

export const DURATION_UNIT_OPTIONS = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' },
  { value: 'weeks', label: 'Semanas' }
]

export const DurationInput: React.FC<{
  amount: number
  unit: string
  onChange: (amount: number, unit: string) => void
}> = ({ amount, unit, onChange }) => (
  <div className={styles.configRow}>
    <TextInput
      type="number"
      min={0}
      value={Number.isFinite(amount) ? amount : 0}
      className={styles.configRowGrow}
      onChange={(event) => onChange(Number(event.target.value), unit)}
    />
    <div className={styles.configRowGrow}>
      <CustomSelect
        options={DURATION_UNIT_OPTIONS}
        value={unit || 'hours'}
        onValueChange={(next) => onChange(amount, next)}
        aria-label="Unidad de tiempo"
      />
    </div>
  </div>
)

/** Sub-bloque visual dentro de un configurador (timeout, ventana horaria…) */
export const ConfigSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className={styles.configSection}>
    <div className={styles.configSectionTitle}>{title}</div>
    {children}
  </div>
)
