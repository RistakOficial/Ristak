import React from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/utils/cn'
import { CustomSelect } from '@/components/common'
import {
  CRM_FIELDS,
  CRM_FIELD_CATEGORIES,
  getCrmField,
  getOperatorsForField,
  operatorNeedsValue,
  type ConditionConfig,
  type ConditionRule
} from '../crmFields'
import { CatalogSelect, Field, TextInput } from './configPrimitives'
import styles from '../AutomationEditor.module.css'

/**
 * Constructor visual de condiciones con campos reales del CRM.
 * Se usa en el nodo "Condición" y en el modo "Condiciones específicas"
 * del nodo "Esperar".
 */

interface ConditionRulesEditorProps {
  value: unknown
  onChange: (value: ConditionConfig) => void
}

const DEFAULT_RULE: ConditionRule = { field: '', operator: '', value: '' }

function normalize(value: unknown): ConditionConfig {
  const raw = (value || {}) as Partial<ConditionConfig>
  return {
    match: raw.match === 'any' ? 'any' : 'all',
    rules: Array.isArray(raw.rules) && raw.rules.length > 0 ? raw.rules : [{ ...DEFAULT_RULE }]
  }
}

export const ConditionRulesEditor: React.FC<ConditionRulesEditorProps> = ({ value, onChange }) => {
  const config = normalize(value)

  const updateRule = (index: number, patch: Partial<ConditionRule>) => {
    const rules = config.rules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule
    )
    onChange({ ...config, rules })
  }

  const renderValueInput = (rule: ConditionRule, index: number) => {
    if (!rule.field || !rule.operator || !operatorNeedsValue(rule.field, rule.operator)) return null
    const field = getCrmField(rule.field)
    if (!field) return null

    // Valor desde catálogo (etiquetas, calendarios, usuarios…)
    if (field.valueCatalog) {
      return (
        <CatalogSelect
          catalog={field.valueCatalog}
          value={rule.value || ''}
          onChange={(next) => updateRule(index, { value: next })}
          placeholder="Selecciona el valor"
          aria-label="Valor"
        />
      )
    }

    // Opciones fijas (estado de cita, canal…)
    if (field.type === 'select' && field.options) {
      return (
        <CustomSelect
          options={field.options}
          value={rule.value || ''}
          onValueChange={(next) => updateRule(index, { value: next })}
          placeholder="Selecciona el valor"
          aria-label="Valor"
        />
      )
    }

    if (field.type === 'duration' || rule.operator === 'last_days' || rule.operator === 'older_days') {
      return (
        <div className={styles.configRow}>
          <TextInput
            type="number"
            min={0}
            className={styles.configRowGrow}
            value={rule.value || ''}
            placeholder="Cantidad"
            onChange={(event) => updateRule(index, { value: event.target.value })}
          />
          {field.type === 'duration' && (
            <div className={styles.configRowGrow}>
              <CustomSelect
                options={[
                  { value: 'minutes', label: 'Minutos' },
                  { value: 'hours', label: 'Horas' },
                  { value: 'days', label: 'Días' }
                ]}
                value={rule.unit || 'hours'}
                onValueChange={(next) => updateRule(index, { unit: next })}
                aria-label="Unidad"
              />
            </div>
          )}
        </div>
      )
    }

    const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'

    if (rule.operator === 'between') {
      return (
        <div className={styles.configRow}>
          <TextInput
            type={inputType}
            className={styles.configRowGrow}
            value={rule.value || ''}
            placeholder="Desde"
            onChange={(event) => updateRule(index, { value: event.target.value })}
          />
          <TextInput
            type={inputType}
            className={styles.configRowGrow}
            value={rule.valueTo || ''}
            placeholder="Hasta"
            onChange={(event) => updateRule(index, { valueTo: event.target.value })}
          />
        </div>
      )
    }

    return (
      <TextInput
        type={inputType}
        value={rule.value || ''}
        placeholder="Valor a comparar"
        onChange={(event) => updateRule(index, { value: event.target.value })}
      />
    )
  }

  return (
    <div>
      <Field label="El contacto debe cumplir">
        <CustomSelect
          options={[
            { value: 'all', label: 'Todas las reglas (Y)' },
            { value: 'any', label: 'Cualquier regla (O)' }
          ]}
          value={config.match}
          onValueChange={(next) => onChange({ ...config, match: next === 'any' ? 'any' : 'all' })}
          aria-label="Tipo de coincidencia"
        />
      </Field>

      {config.rules.map((rule, index) => {
        const field = rule.field ? getCrmField(rule.field) : undefined
        const operators = rule.field ? getOperatorsForField(rule.field) : []
        return (
          <div key={index} className={styles.conditionRule}>
            <div className={styles.conditionRuleHeader}>
              <span className={styles.conditionRuleTitle}>
                {index === 0 ? 'Si' : config.match === 'any' ? 'O si' : 'Y si'}
              </span>
              <button
                type="button"
                className={styles.configIconButton}
                title="Quitar regla"
                onClick={() =>
                  onChange({
                    ...config,
                    rules:
                      config.rules.length > 1
                        ? config.rules.filter((_, ruleIndex) => ruleIndex !== index)
                        : [{ ...DEFAULT_RULE }]
                  })
                }
              >
                <Trash2 size={12} />
              </button>
            </div>

            <CustomSelect
              value={rule.field}
              onValueChange={(next) =>
                updateRule(index, { field: next, operator: '', value: '', valueTo: '', customKey: '' })
              }
              placeholder="Selecciona un campo del CRM"
              aria-label="Campo"
            >
              {CRM_FIELD_CATEGORIES.map((category) => (
                <optgroup key={category.id} label={category.label}>
                  {CRM_FIELDS.filter((candidate) => candidate.category === category.id).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </CustomSelect>

            {field?.needsCustomKey && (
              <div style={{ marginTop: 6 }}>
                <CatalogSelect
                  catalog="contactFields"
                  value={rule.customKey || ''}
                  onChange={(next) => updateRule(index, { customKey: next })}
                  placeholder="¿Cuál campo?"
                  aria-label="Campo personalizado"
                />
              </div>
            )}

            {rule.field && (
              <div style={{ marginTop: 6 }}>
                <CustomSelect
                  options={operators.map((operator) => ({ value: operator.value, label: operator.label }))}
                  value={rule.operator}
                  onValueChange={(next) => updateRule(index, { operator: next })}
                  placeholder="Selecciona un operador"
                  aria-label="Operador"
                />
              </div>
            )}

            <div className={cn(rule.field && rule.operator && styles.conditionValue)}>
              {renderValueInput(rule, index)}
            </div>
          </div>
        )
      })}

      <button
        type="button"
        className={styles.configSmallButton}
        onClick={() => onChange({ ...config, rules: [...config.rules, { ...DEFAULT_RULE }] })}
      >
        <Plus size={11} />
        Agregar regla
      </button>
    </div>
  )
}
