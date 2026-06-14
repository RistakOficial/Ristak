import React from 'react'
import { Plus, X } from 'lucide-react'
import {
  TRIGGER_FILTER_OPERATORS,
  asTriggerFilters,
  filterFieldsFor,
  triggerOperatorNeedsValue,
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
}> = ({ value, onChange, contextKey }) => {
  const filters = asTriggerFilters(value)
  const fields = filterFieldsFor(contextKey)

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
        const fieldReady = Boolean(filter.field) && (filter.field !== 'custom' || Boolean(filter.customKey))
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

            {fieldReady && (
              <div className={styles.filterStep}>
                <div className={styles.configRow}>
                  <CustomSelect
                    options={TRIGGER_FILTER_OPERATORS.map((operator) => ({
                      value: operator.value,
                      label: operator.label
                    }))}
                    value={filter.match || ''}
                    onValueChange={(next) => update(index, { match: next as TriggerFilter['match'] })}
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
