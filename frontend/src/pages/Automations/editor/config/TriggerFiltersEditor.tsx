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
 * del contacto, agrupados en categorías tipo Finder. Cada filtro se une
 * al anterior con Y / O (la columna está reservada desde el inicio para
 * que nada se empuje).
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
        return (
          <div key={index} className={styles.filterRow}>
            <div className={styles.configRow}>
              {/* Columna fija: Y / O (la primera fila siempre une con Y) */}
              <span className={styles.filterConnector}>
                {index === 0 ? (
                  <span className={styles.filterConnectorStatic}>Y</span>
                ) : (
                  <CustomSelect
                    options={[
                      { value: 'and', label: 'Y' },
                      { value: 'or', label: 'O' }
                    ]}
                    value={filter.connector === 'or' ? 'or' : 'and'}
                    onValueChange={(next) => update(index, { connector: next === 'or' ? 'or' : 'and' })}
                    aria-label="Unir con"
                  />
                )}
              </span>
              <div className={styles.configRowGrow}>
                <DrillSelect
                  groups={groups}
                  value={filter.field}
                  onValueChange={(next) =>
                    update(index, { field: next, value: '', customKey: '', customLabel: '' })
                  }
                  placeholder="Elige el campo"
                  aria-label="Campo del filtro"
                />
              </div>
              <button
                type="button"
                className={styles.configIconButton}
                title="Quitar filtro"
                onClick={() => onChange(filters.filter((_, i) => i !== index))}
              >
                <X size={12} />
              </button>
            </div>

            {filter.field === 'custom' && (
              <div style={{ marginTop: 6 }}>
                <CatalogSelect
                  catalog="contactFields"
                  value={filter.customKey || ''}
                  onChange={(next, label) => update(index, { customKey: next, customLabel: label })}
                  placeholder="¿Cuál campo personalizado?"
                  aria-label="Campo personalizado"
                />
              </div>
            )}

            {filter.field && (
              <div className={styles.configRow} style={{ marginTop: 6 }}>
                <div style={{ width: 150, flexShrink: 0 }}>
                  <CustomSelect
                    options={TRIGGER_FILTER_OPERATORS.map((operator) => ({
                      value: operator.value,
                      label: operator.label
                    }))}
                    value={filter.match || 'is'}
                    onValueChange={(next) => update(index, { match: next as TriggerFilter['match'] })}
                    aria-label="Coincidencia"
                  />
                </div>
                {triggerOperatorNeedsValue(filter.match) && (
                  <div className={styles.configRowGrow}>
                    {field?.options ? (
                      <CustomSelect
                        options={field.options}
                        value={filter.value}
                        onValueChange={(next) => update(index, { value: next })}
                        placeholder="Valor"
                        aria-label="Valor del filtro"
                      />
                    ) : field?.catalog ? (
                      <CatalogSelect
                        catalog={field.catalog}
                        value={filter.value}
                        onChange={(next) => update(index, { value: next })}
                        placeholder="Valor"
                        aria-label="Valor del filtro"
                      />
                    ) : (
                      <TextInput
                        value={filter.value}
                        placeholder="Valor"
                        onChange={(event) => update(index, { value: event.target.value })}
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
        onClick={() => onChange([...filters, { field: '', match: 'is', value: '', connector: 'and' }])}
      >
        <Plus size={11} />
        Añadir filtro
      </button>
    </div>
  )
}
