import React, { useEffect, useState } from 'react'
import { cn } from '@/utils/cn'
import { CustomSelect as BaseCustomSelect, NumberInput as BaseNumberInput, TagPicker } from '@/components/common'

/** CustomSelect con portal: el dropdown se dibuja por delante del panel
 *  de configuración (los contenedores con scroll lo recortaban). */
export const CustomSelect: React.FC<React.ComponentProps<typeof BaseCustomSelect>> = (props) => (
  <BaseCustomSelect portal size="large" {...props} />
)
import { getCatalog, getFormsCatalogPage, type CatalogKind, type CatalogOption } from '@/services/automationCatalogsService'
import { CONTACT_VARIABLES } from '../nodeRegistry'
import { DrillSelect } from './DrillSelect'
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

export const NumberTextInput: React.FC<React.ComponentProps<typeof BaseNumberInput>> = ({ className, ...props }) => (
  <BaseNumberInput className={cn(styles.configInput, className)} {...props} />
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

function mergeCatalogOptions(current: CatalogOption[], incoming: CatalogOption[]) {
  const byValue = new Map(current.map(option => [option.value, option]))
  incoming.forEach(option => byValue.set(option.value, option))
  return [...byValue.values()]
}

function usePagedFormsCatalog(selectedId: string) {
  const [options, setOptions] = useState<CatalogOption[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const openRef = React.useRef(false)
  const requestRef = React.useRef<AbortController | null>(null)
  const hydrationRef = React.useRef<AbortController | null>(null)
  const searchTimerRef = React.useRef<number | null>(null)

  const loadPage = React.useCallback(async ({
    reset = false,
    query = search
  }: { reset?: boolean; query?: string } = {}) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    try {
      const page = await getFormsCatalogPage({
        limit: 30,
        cursor: reset ? null : nextCursor,
        search: query,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      setOptions(current => mergeCatalogOptions(reset ? current.filter(option => option.value === selectedId) : current, page.items))
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
      setLoaded(true)
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        setHasMore(false)
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }, [nextCursor, search, selectedId])

  useEffect(() => {
    const cleanSelectedId = String(selectedId || '').trim()
    if (!cleanSelectedId || options.some(option => option.value === cleanSelectedId)) return
    hydrationRef.current?.abort()
    const controller = new AbortController()
    hydrationRef.current = controller
    void getFormsCatalogPage({ selectedIds: [cleanSelectedId], signal: controller.signal })
      .then(page => {
        if (!controller.signal.aborted) setOptions(current => mergeCatalogOptions(current, page.items))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [options, selectedId])

  useEffect(() => () => {
    requestRef.current?.abort()
    hydrationRef.current?.abort()
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current)
  }, [])

  const handleOpenChange = React.useCallback((open: boolean) => {
    openRef.current = open
    if (open && !loaded && !loading) void loadPage({ reset: true, query: search })
  }, [loadPage, loaded, loading, search])

  const handleSearchChange = React.useCallback((query: string) => {
    setSearch(query)
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current)
    if (!openRef.current) {
      if (!query && search) setLoaded(false)
      return
    }
    searchTimerRef.current = window.setTimeout(() => {
      void loadPage({ reset: true, query })
    }, 250)
  }, [loadPage, search])

  return {
    options,
    loading,
    hasMore,
    onOpenChange: handleOpenChange,
    onSearchChange: handleSearchChange,
    onLoadMore: () => {
      if (!loading && hasMore && nextCursor) void loadPage()
    }
  }
}

type SelectOption = {
  value: string
  label: string
  disabled?: boolean
}

function optionMatchesSavedValue(option: CatalogOption | SelectOption, value: string) {
  const cleanValue = String(value || '').trim()
  if (!cleanValue) return true
  return option.value === cleanValue || option.label.trim().toLowerCase() === cleanValue.toLowerCase()
}

interface CatalogSelectProps {
  catalog: CatalogKind
  value: string
  placeholder?: string
  includeSystemTags?: boolean
  'aria-label'?: string
  /** Recibe el valor y la etiqueta legible de la opción elegida */
  onChange: (value: string, label: string) => void
}

export const CatalogSelect: React.FC<CatalogSelectProps> = ({
  catalog,
  value,
  placeholder,
  includeSystemTags = false,
  onChange,
  ...rest
}) => {
  const staticCatalog = useCatalogOptions(catalog === 'forms' ? undefined : catalog)
  const pagedFormsCatalog = usePagedFormsCatalog(catalog === 'forms' ? value : '')
  const { options, loading } = catalog === 'forms' ? pagedFormsCatalog : staticCatalog

  // Etiquetas: selector con buscador y "crear etiqueta" inline (catálogo real)
  if (catalog === 'tags') {
    const hasSavedValue = Boolean(value) && !loading && !options.some((option) => optionMatchesSavedValue(option, value))
    return (
      <TagPicker
        value={value}
        onValueChange={(next, label) => onChange(next, label)}
        includeSystem={includeSystemTags}
        allowCreate
        portal
        size="large"
        className={hasSavedValue ? styles.configSelectMissing : undefined}
        missingLabel={hasSavedValue ? `${value} · ya no existe` : undefined}
        placeholder={placeholder || 'Selecciona una etiqueta'}
        aria-label={rest['aria-label']}
      />
    )
  }

  if (loading) {
    if (catalog === 'forms') {
      // El combo se mantiene disponible para pintar el valor guardado mientras
      // busca la primera página; el estado de carga vive dentro del dropdown.
    } else {
    return <span className={styles.configHelp} role="status" aria-live="polite" aria-label="Cargando opciones" />
    }
  }

  if (catalog === 'customFields') {
    const selectOptions: SelectOption[] = options.map((option) => ({
      value: option.value,
      label: option.meta ? `${option.label} · ${option.meta}` : option.label
    }))
    const hasSavedValue = Boolean(value) && !selectOptions.some((option) => option.value === value)
    if (hasSavedValue) {
      selectOptions.unshift({ value, label: `${value} · ya no existe`, disabled: true })
    }
    if (selectOptions.length === 0) {
      return <span className={styles.configHelp}>No hay campos personalizados activos todavía.</span>
    }
    return (
      <CustomSelect
        options={selectOptions}
        value={value}
        onValueChange={(next) => {
          const selected = options.find((option) => option.value === next)
          onChange(next, selected?.label || next)
        }}
        placeholder={placeholder || 'Selecciona el campo personalizado'}
        className={hasSavedValue ? styles.configSelectMissing : undefined}
        aria-label={rest['aria-label']}
      />
    )
  }

  // Campos de contacto: drill-down con categorías (datos básicos vs personalizados)
  if (catalog === 'contactFields') {
    const basics = options.filter((option) => !option.value.startsWith('custom:'))
    const custom = options.filter((option) => option.value.startsWith('custom:'))
    return (
      <DrillSelect
        groups={[
          { id: 'basics', label: 'Datos del contacto', items: basics.map((option) => ({ value: option.value, label: option.label })) },
          { id: 'custom', label: 'Campos personalizados', items: custom.map((option) => ({ value: option.value, label: option.label })) }
        ]}
        value={value}
        onValueChange={(next, label) => onChange(next, label)}
        placeholder={placeholder || 'Selecciona el campo'}
        aria-label={rest['aria-label']}
      />
    )
  }

  const selectOptions: SelectOption[] = options.map((option) => ({
    value: option.value,
    label: option.meta ? `${option.label} · ${option.meta}` : option.label
  }))
  const hasSavedValue = Boolean(value) && !selectOptions.some((option) => option.value === value)
  if (hasSavedValue) {
    selectOptions.unshift({ value, label: `${value} · ya no existe`, disabled: true })
  }

  if (selectOptions.length === 0) {
    return <span className={styles.configHelp}>No hay opciones disponibles todavía.</span>
  }

  return (
    <CustomSelect
      options={selectOptions}
      value={value}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next)
        onChange(next, selected?.label || next)
      }}
      placeholder={placeholder || 'Selecciona una opción'}
      className={hasSavedValue ? styles.configSelectMissing : undefined}
      aria-label={rest['aria-label']}
      searchable={catalog === 'forms'}
      searchPlaceholder={catalog === 'forms' ? 'Buscar formulario…' : undefined}
      onOpenChange={catalog === 'forms' ? pagedFormsCatalog.onOpenChange : undefined}
      onSearchChange={catalog === 'forms' ? pagedFormsCatalog.onSearchChange : undefined}
      onLoadMore={catalog === 'forms' ? pagedFormsCatalog.onLoadMore : undefined}
      hasMore={catalog === 'forms' ? pagedFormsCatalog.hasMore : false}
      loading={catalog === 'forms' ? pagedFormsCatalog.loading : false}
      emptyMessage={catalog === 'forms' ? 'No hay formularios para esta búsqueda' : undefined}
    />
  )
}

/** Chips multi-selección desde un catálogo (p. ej. etiquetas iniciales) */
export const CatalogTags: React.FC<{
  catalog: CatalogKind
  values: string[]
  includeSystemTags?: boolean
  onChange: (values: string[]) => void
  'aria-label'?: string
}> = ({ catalog, values, includeSystemTags = false, onChange, ...rest }) => {
  const { options, loading } = useCatalogOptions(catalog)
  const remaining = options.filter((option) => !values.includes(option.value))

  // Etiquetas: chips con buscador y "crear etiqueta" inline (catálogo real)
  if (catalog === 'tags') {
    return (
      <TagPicker
        multiple
        selectedIds={values}
        onChange={onChange}
        includeSystem={includeSystemTags}
        allowCreate
        portal
        size="large"
        aria-label={rest['aria-label']}
      />
    )
  }

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
        <span className={styles.configHelp} role="status" aria-live="polite" aria-label="Cargando opciones" />
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
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' },
  { value: 'days', label: 'Días' },
  { value: 'weeks', label: 'Semanas' }
]

export const DurationInput: React.FC<{
  amount: number
  unit: string
  onChange: (amount: number, unit: string) => void
}> = ({ amount, unit, onChange }) => {
  const formatAmount = (value: number) => (Number.isFinite(value) && value > 0 ? String(value) : '')
  const [draftAmount, setDraftAmount] = useState(formatAmount(amount))
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraftAmount(formatAmount(amount))
    }
  }, [amount, editing])

  const currentAmount = formatAmount(amount)
  const commitAmount = (raw: string) => {
    const parsed = Number(raw)
    onChange(raw === '' || !Number.isFinite(parsed) ? 0 : parsed, unit)
  }

  return (
    <div className={styles.configRow}>
      <NumberTextInput
        min={0}
        value={editing ? draftAmount : currentAmount}
        placeholder="0"
        className={styles.configRowGrow}
        onFocus={() => {
          setEditing(true)
          setDraftAmount(currentAmount)
        }}
        onChange={(event) => {
          const next = event.target.value
          setDraftAmount(next)
          commitAmount(next)
        }}
        onBlur={() => {
          setEditing(false)
          setDraftAmount(formatAmount(amount))
        }}
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
}

/** Sub-bloque visual dentro de un configurador (timeout, ventana horaria…) */
export const ConfigSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className={styles.configSection}>
    <div className={styles.configSectionTitle}>{title}</div>
    {children}
  </div>
)
