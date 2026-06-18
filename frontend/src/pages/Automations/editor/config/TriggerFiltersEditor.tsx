import React, { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { getFormFieldCatalog, type CatalogOption } from '@/services/automationCatalogsService'
import {
  asTriggerFilters,
  filterFieldsFor,
  triggerOperatorNeedsValue,
  triggerOperatorsForField,
  type TriggerFilter
} from '../crmFields'
import { CatalogSelect, TextInput, CustomSelect } from './configPrimitives'
import { DrillSelect, type DrillGroup } from './DrillSelect'
import styles from '../AutomationEditor.module.css'

/**
 * Filtros de un disparador u objetivo ("+ Añadir filtro"): solo ofrece
 * campos congruentes con el evento (mensaje, cita, pago…) más los datos
 * del contacto, agrupados en categorías tipo Finder. Cada filtro guía al
 * usuario por pasos: dato, comparación y valor.
 */

export const TriggerFiltersEditor: React.FC<{
  value: unknown
  onChange: (filters: TriggerFilter[]) => void
  /** Tipo del disparador (u objetivo) para mostrar solo campos congruentes */
  contextKey?: string
  /** Formulario elegido en el disparador/objetivo para cargar sus preguntas */
  selectedFormId?: string
}> = ({ value, onChange, contextKey, selectedFormId }) => {
  const filters = asTriggerFilters(value)
  const fields = filterFieldsFor(contextKey)
  const formIdForQuestions = selectedFormId || filters.find((filter) => filter.field === 'form-specific' && filter.value)?.value || ''

  const groups: DrillGroup[] = []
  fields.forEach((field) => {
    let group = groups.find((candidate) => candidate.id === field.category)
    if (!group) {
      group = { id: field.category, label: field.category, items: [] }
      groups.push(group)
    }
    group.items.push({ value: field.id, label: field.label })
  })

  const update = (index: number, patch: Partial<TriggerFilter>) => {
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)))
  }

  return (
    <div>
      {filters.map((filter, index) => {
        const field = fields.find((candidate) => candidate.id === filter.field)
        const needsCustomKey = Boolean(field?.needsCustomKey)
        const fieldReady = Boolean(filter.field) && (!needsCustomKey || Boolean(filter.customKey))
        const operators = triggerOperatorsForField(field)
        const needsValue = Boolean(filter.match) && triggerOperatorNeedsValue(filter.match)
        return (
          <div key={index} className={styles.filterRow}>
            <div className={styles.filterHeaderRow}>
              {index === 0 ? (
                <span className={styles.filterSentenceLead}>Sólo continuar cuando</span>
              ) : (
                <div className={styles.filterConnectorSelect}>
                  <CustomSelect
                    options={[
                      { value: 'and', label: 'También debe cumplir' },
                      { value: 'or', label: 'O puede cumplir' }
                    ]}
                    value={filter.connector === 'or' ? 'or' : 'and'}
                    onValueChange={(next) => update(index, { connector: next === 'or' ? 'or' : 'and' })}
                    aria-label="Cómo combinar este filtro"
                  />
                </div>
              )}
              <button
                type="button"
                className={styles.configIconButton}
                title="Quitar filtro"
                onClick={() => onChange(filters.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </button>
            </div>

            <div className={styles.configRow}>
              <div className={styles.configRowGrow}>
                <DrillSelect
                  groups={groups}
                  value={filter.field}
                  onValueChange={(next) =>
                    update(index, { field: next, match: '', value: '', valueLabel: '', customKey: '', customLabel: '' })
                  }
                  placeholder="Selecciona qué dato revisar"
                  aria-label="Campo del filtro"
                />
              </div>
            </div>

            {filter.field === 'custom' && (
              <div className={styles.filterStep}>
                <CatalogSelect
                  catalog="customFields"
                  value={filter.customKey || ''}
                  onChange={(next, label) => update(index, { customKey: next, customLabel: label })}
                  placeholder="Elige el campo personalizado"
                  aria-label="Campo personalizado"
                />
              </div>
            )}

            {filter.field === 'form_field' && (
              <div className={styles.filterStep}>
                <FormFieldSelect
                  formId={formIdForQuestions}
                  value={filter.customKey || ''}
                  savedLabel={filter.customLabel || ''}
                  onChange={(next, label) => update(index, { customKey: next, customLabel: label })}
                />
              </div>
            )}

            {fieldReady && (
              <div className={styles.filterStep}>
                <div className={styles.configRow}>
                  <CustomSelect
                    options={operators.map((operator) => ({
                      value: operator.value,
                      label: operator.label
                    }))}
                    value={filter.match || ''}
                    onValueChange={(next) =>
                      update(index, {
                        match: next as TriggerFilter['match'],
                        ...(triggerOperatorNeedsValue(next) ? {} : { value: '', valueLabel: '' })
                      })
                    }
                    placeholder="Selecciona qué debe pasar"
                    aria-label="Qué debe pasar"
                  />
                </div>
                {needsValue && (
                  <div className={styles.filterStep}>
                    {field?.options ? (
                      <CustomSelect
                        options={field.options}
                        value={filter.value}
                        onValueChange={(next) =>
                          update(index, {
                            value: next,
                            valueLabel: field.options?.find((option) => option.value === next)?.label || next
                          })
                        }
                        placeholder="Valor"
                        aria-label="Valor del filtro"
                      />
                    ) : field?.catalog ? (
                      <CatalogSelect
                        catalog={field.catalog}
                        value={filter.value}
                        onChange={(next, label) => update(index, { value: next, valueLabel: label })}
                        placeholder="Valor"
                        aria-label="Valor del filtro"
                      />
                    ) : (
                      <TextInput
                        type={field?.type === 'number' ? 'number' : 'text'}
                        value={filter.value}
                        placeholder="Valor"
                        onChange={(event) => update(index, { value: event.target.value, valueLabel: '' })}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <button
        type="button"
        className={styles.configSmallButton}
        onClick={() => onChange([...filters, { field: '', match: '', value: '', connector: 'and' }])}
      >
        <Plus size={11} />
        Añadir filtro
      </button>
    </div>
  )
}

const FormFieldSelect: React.FC<{
  formId: string
  value: string
  savedLabel?: string
  onChange: (value: string, label: string) => void
}> = ({ formId, value, savedLabel, onChange }) => {
  const [options, setOptions] = useState<CatalogOption[]>([])
  const [loading, setLoading] = useState(Boolean(formId))

  useEffect(() => {
    const cleanFormId = String(formId || '').trim()
    if (!cleanFormId) {
      setOptions([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    getFormFieldCatalog(cleanFormId).then((loaded) => {
      if (cancelled) return
      setOptions(loaded)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [formId])

  const selectOptions = useMemo(() => {
    const mapped = options.map((option) => ({
      value: option.value,
      label: option.meta ? `${option.label} · ${option.meta}` : option.label
    }))
    if (value && !mapped.some((option) => option.value === value)) {
      mapped.unshift({ value, label: `${savedLabel || value} · guardado` })
    }
    return mapped
  }, [options, savedLabel, value])

  if (!formId) {
    return <span className={styles.configHelp}>Primero selecciona el formulario del disparador.</span>
  }

  if (loading) {
    return <span className={styles.configHelp} role="status" aria-live="polite">Cargando preguntas del formulario...</span>
  }

  if (selectOptions.length === 0) {
    return <span className={styles.configHelp}>Este formulario todavía no tiene preguntas detectadas.</span>
  }

  return (
    <CustomSelect
      options={selectOptions}
      value={value}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next)
        onChange(next, selected?.label || savedLabel || next)
      }}
      placeholder="Elige la pregunta del formulario"
      aria-label="Pregunta del formulario"
    />
  )
}
