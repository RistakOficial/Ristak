import React from 'react'
import { Plus, X } from 'lucide-react'
import {
  TRIGGER_FILTER_FIELDS,
  asTriggerFilters,
  type TriggerFilter
} from '../crmFields'
import { CatalogSelect, Field, TextInput, CustomSelect } from './configPrimitives'
import styles from '../AutomationEditor.module.css'

/**
 * Filtros avanzados de un disparador ("+ Añadir filtro"):
 * cada filtro se lee como "la fuente coincide con Facebook" y soporta
 * coincide / NO coincide. Solo aparecen si el usuario los agrega.
 */

export const TriggerFiltersEditor: React.FC<{
  value: unknown
  onChange: (filters: TriggerFilter[]) => void
}> = ({ value, onChange }) => {
  const filters = asTriggerFilters(value)

  const update = (index: number, patch: Partial<TriggerFilter>) => {
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)))
  }

  return (
    <div>
      {filters.map((filter, index) => {
        const field = TRIGGER_FILTER_FIELDS.find((candidate) => candidate.id === filter.field)
        return (
          <div key={index} className={styles.filterRow}>
            <div className={styles.configRow}>
              <span className={styles.conditionRuleTitle}>{index === 0 ? 'Y' : 'Y'}</span>
              <div className={styles.configRowGrow}>
                <CustomSelect
                  options={TRIGGER_FILTER_FIELDS.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.label
                  }))}
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
                    options={[
                      { value: 'is', label: 'coincide con' },
                      { value: 'not', label: 'NO coincide con' }
                    ]}
                    value={filter.match || 'is'}
                    onValueChange={(next) => update(index, { match: next === 'not' ? 'not' : 'is' })}
                    aria-label="Coincidencia"
                  />
                </div>
                <div className={styles.configRowGrow}>
                  {field?.catalog ? (
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
              </div>
            )}
          </div>
        )
      })}

      <button
        type="button"
        className={styles.configSmallButton}
        onClick={() => onChange([...filters, { field: '', match: 'is', value: '' }])}
      >
        <Plus size={11} />
        Añadir filtro
      </button>
    </div>
  )
}

void Field
