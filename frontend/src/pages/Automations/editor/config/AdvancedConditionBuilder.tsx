import React from 'react'
import { Braces, Plus, Trash2, Type } from 'lucide-react'
import { cn } from '@/utils/cn'
import { CustomSelect } from './configPrimitives'
import {
  CRM_FIELDS,
  CRM_FIELD_CATEGORIES,
  emptyConditionBranch,
  emptyConditionGroup,
  getCrmField,
  getOperatorsForField,
  operatorNeedsValue,
  type AdvancedConditionConfig,
  type ConditionBranch,
  type ConditionGroup,
  type ConditionRule
} from '../crmFields'
import { MAX_BRANCHES } from '../nodeRegistry'
import { CatalogSelect, Field, TextInput } from './configPrimitives'
import { VariableTextInput } from '../composer/MessageComposer'
import { DrillSelect } from './DrillSelect'
import styles from '../AutomationEditor.module.css'

/**
 * Constructor avanzado de condiciones tipo HighLevel (en español):
 * ramas con nombre → grupos combinables con Y/O (negables) → reglas con
 * campos reales del CRM, operadores por tipo y valores fijos o dinámicos.
 */

interface AdvancedConditionBuilderProps {
  value: unknown
  onChange: (value: AdvancedConditionConfig) => void
  /** Permite varias ramas con salida propia (nodo Condición) */
  allowBranches?: boolean
}

const DEFAULT_RULE: ConditionRule = { field: '', operator: '', value: '' }

function normalize(value: unknown): AdvancedConditionConfig {
  const raw = (value || {}) as Partial<AdvancedConditionConfig>
  const branches = Array.isArray(raw.branches) && raw.branches.length > 0
    ? raw.branches.map((branch) => ({
        ...branch,
        groupsOperator: branch.groupsOperator === 'OR' ? 'OR' as const : 'AND' as const,
        groups:
          Array.isArray(branch.groups) && branch.groups.length > 0
            ? branch.groups.map((group) => ({
                ...group,
                operator: group.operator === 'OR' ? 'OR' as const : 'AND' as const,
                rules: Array.isArray(group.rules) && group.rules.length > 0 ? group.rules : [{ ...DEFAULT_RULE }]
              }))
            : [emptyConditionGroup()]
      }))
    : [emptyConditionBranch()]
  return { branches }
}

export const AdvancedConditionBuilder: React.FC<AdvancedConditionBuilderProps> = ({
  value,
  onChange,
  allowBranches = false
}) => {
  const config = normalize(value)
  const multiBranch = allowBranches && config.branches.length > 1

  const updateBranch = (branchIndex: number, patch: Partial<ConditionBranch>) => {
    onChange({
      branches: config.branches.map((branch, index) =>
        index === branchIndex ? { ...branch, ...patch } : branch
      )
    })
  }

  const updateGroup = (branchIndex: number, groupIndex: number, patch: Partial<ConditionGroup>) => {
    const branch = config.branches[branchIndex]
    updateBranch(branchIndex, {
      groups: branch.groups.map((group, index) => (index === groupIndex ? { ...group, ...patch } : group))
    })
  }

  const updateRule = (branchIndex: number, groupIndex: number, ruleIndex: number, patch: Partial<ConditionRule>) => {
    const group = config.branches[branchIndex].groups[groupIndex]
    updateGroup(branchIndex, groupIndex, {
      rules: group.rules.map((rule, index) => (index === ruleIndex ? { ...rule, ...patch } : rule))
    })
  }

  // ------------------------------------------------------------------
  // Valor de una regla (fijo, por catálogo o variable dinámica)
  // ------------------------------------------------------------------
  const renderValueInput = (rule: ConditionRule, set: (patch: Partial<ConditionRule>) => void) => {
    if (!rule.field || !rule.operator || !operatorNeedsValue(rule.field, rule.operator)) return null
    const field = getCrmField(rule.field)
    if (!field) return null

    const variableMode = rule.valueMode === 'variable'

    const modeToggle = (
      <button
        type="button"
        className={styles.composerToolButton}
        title={variableMode ? 'Usar valor fijo' : 'Comparar contra una variable'}
        onClick={() => set({ valueMode: variableMode ? 'fixed' : 'variable', value: '', valueLabel: '' })}
      >
        {variableMode ? <Type size={12} /> : <Braces size={12} />}
      </button>
    )

    if (variableMode) {
      return (
        <div className={styles.configRow}>
          <div className={styles.configRowGrow}>
            <VariableTextInput
              value={rule.value || ''}
              onChange={(compiled) => set({ value: compiled, valueLabel: '' })}
              placeholder="Inserta una variable…"
              aria-label="Valor dinámico"
            />
          </div>
          {modeToggle}
        </div>
      )
    }

    let input: React.ReactNode

    if (field.valueCatalog) {
      input = (
        <CatalogSelect
          catalog={field.valueCatalog}
          value={rule.value || ''}
          onChange={(next, label) => set({ value: next, valueLabel: label })}
          placeholder="Selecciona el valor"
          aria-label="Valor"
        />
      )
    } else if (field.type === 'select' && field.options) {
      input = (
        <CustomSelect
          options={field.options}
          value={rule.value || ''}
          onValueChange={(next) =>
            set({ value: next, valueLabel: field.options?.find((option) => option.value === next)?.label || next })
          }
          placeholder="Selecciona el valor"
          aria-label="Valor"
        />
      )
    } else if (field.type === 'duration' || rule.operator === 'last_days' || rule.operator === 'older_days') {
      input = (
        <div className={styles.configRow}>
          <TextInput
            type="number"
            min={0}
            className={styles.configRowGrow}
            value={rule.value || ''}
            placeholder="Cantidad"
            onChange={(event) => set({ value: event.target.value, valueLabel: '' })}
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
                onValueChange={(next) => set({ unit: next })}
                aria-label="Unidad"
              />
            </div>
          )}
        </div>
      )
    } else {
      const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
      input =
        rule.operator === 'between' ? (
          <div className={styles.configRow}>
            <TextInput
              type={inputType}
              className={styles.configRowGrow}
              value={rule.value || ''}
              placeholder="Desde"
              onChange={(event) => set({ value: event.target.value, valueLabel: '' })}
            />
            <TextInput
              type={inputType}
              className={styles.configRowGrow}
              value={rule.valueTo || ''}
              placeholder="Hasta"
              onChange={(event) => set({ valueTo: event.target.value })}
            />
          </div>
        ) : (
          <TextInput
            type={inputType}
            value={rule.value || ''}
            placeholder="Valor a comparar"
            onChange={(event) => set({ value: event.target.value, valueLabel: '' })}
          />
        )
    }

    return (
      <div className={styles.configRow}>
        <div className={styles.configRowGrow}>{input}</div>
        {modeToggle}
      </div>
    )
  }

  const renderRule = (
    rule: ConditionRule,
    branchIndex: number,
    groupIndex: number,
    ruleIndex: number,
    group: ConditionGroup
  ) => {
    const field = rule.field ? getCrmField(rule.field) : undefined
    const canSelectOperator = Boolean(rule.field) && (!field?.needsCustomKey || Boolean(rule.customKey))
    const operators = canSelectOperator ? getOperatorsForField(rule.field) : []
    const ruleLead = ruleIndex === 0
      ? 'Regla principal'
      : group.operator === 'OR'
        ? 'O puede cumplirse'
        : 'También debe cumplirse'
    return (
      <div key={ruleIndex} className={styles.conditionRule}>
        <div className={styles.conditionRuleHeader}>
          <span className={styles.conditionRuleTitle}>{ruleLead}</span>
          <button
            type="button"
            className={styles.configIconButton}
            title="Quitar regla"
            onClick={() =>
              updateGroup(branchIndex, groupIndex, {
                rules:
                  group.rules.length > 1
                    ? group.rules.filter((_, index) => index !== ruleIndex)
                    : [{ ...DEFAULT_RULE }]
              })
            }
          >
            <Trash2 size={12} />
          </button>
        </div>

        <DrillSelect
          groups={CRM_FIELD_CATEGORIES.map((category) => ({
            id: category.id,
            label: category.label,
            items: CRM_FIELDS.filter((candidate) => candidate.category === category.id).map((candidate) => ({
              value: candidate.id,
              label: candidate.label
            }))
          }))}
          value={rule.field}
          onValueChange={(next) =>
            updateRule(branchIndex, groupIndex, ruleIndex, {
              field: next,
              operator: '',
              value: '',
              valueLabel: '',
              valueTo: '',
              customKey: '',
              customLabel: '',
              valueMode: 'fixed'
            })
          }
          placeholder="Selecciona qué dato revisar"
          aria-label="Campo"
        />

        {field?.needsCustomKey && (
          <div style={{ marginTop: 6 }}>
            <CatalogSelect
              catalog="customFields"
              value={rule.customKey || ''}
              onChange={(next, label) => updateRule(branchIndex, groupIndex, ruleIndex, { customKey: next, customLabel: label })}
              placeholder="Elige el campo personalizado"
              aria-label="Campo personalizado"
            />
          </div>
        )}

        {canSelectOperator && (
          <div style={{ marginTop: 6 }}>
            <CustomSelect
              options={operators.map((operator) => ({ value: operator.value, label: operator.label }))}
              value={rule.operator}
              onValueChange={(next) => updateRule(branchIndex, groupIndex, ruleIndex, { operator: next })}
              placeholder="Selecciona qué debe pasar"
              aria-label="Qué debe pasar"
            />
          </div>
        )}

        <div className={cn(rule.field && rule.operator && styles.conditionValue)}>
          {renderValueInput(rule, (patch) => updateRule(branchIndex, groupIndex, ruleIndex, patch))}
        </div>
      </div>
    )
  }

  const renderGroup = (group: ConditionGroup, branchIndex: number, groupIndex: number, branch: ConditionBranch) => (
    <React.Fragment key={group.id || groupIndex}>
      {groupIndex > 0 && (
        <div className={styles.groupConnector}>
          <CustomSelect
            options={[
              { value: 'AND', label: 'También debe cumplirse este grupo' },
              { value: 'OR', label: 'Este grupo es una alternativa' }
            ]}
            value={branch.groupsOperator}
            onValueChange={(next) =>
              updateBranch(branchIndex, { groupsOperator: next === 'OR' ? 'OR' : 'AND' })
            }
            aria-label="Cómo combinar grupos"
          />
        </div>
      )}
      <div className={cn(styles.conditionGroup, group.negate && styles.conditionGroupNegated)}>
        <div className={styles.conditionGroupHeader}>
          <CustomSelect
            options={[
              { value: 'AND', label: 'Deben cumplirse todas las reglas' },
              { value: 'OR', label: 'Puede cumplirse cualquier regla' }
            ]}
            value={group.operator}
            onValueChange={(next) =>
              updateGroup(branchIndex, groupIndex, { operator: next === 'OR' ? 'OR' : 'AND' })
            }
            aria-label="Cómo evaluar este grupo"
          />
          <button
            type="button"
            className={cn(styles.negateButton, group.negate && styles.negateButtonActive)}
            title='Negar el grupo: "No se cumple"'
            onClick={() => updateGroup(branchIndex, groupIndex, { negate: !group.negate })}
          >
            No se cumple
          </button>
          <button
            type="button"
            className={styles.configIconButton}
            title="Quitar grupo"
            onClick={() =>
              updateBranch(branchIndex, {
                groups:
                  branch.groups.length > 1
                    ? branch.groups.filter((_, index) => index !== groupIndex)
                    : [emptyConditionGroup()]
              })
            }
          >
            <Trash2 size={12} />
          </button>
        </div>

        {group.rules.map((rule, ruleIndex) => renderRule(rule, branchIndex, groupIndex, ruleIndex, group))}

        <button
          type="button"
          className={styles.configSmallButton}
          onClick={() =>
            updateGroup(branchIndex, groupIndex, { rules: [...group.rules, { ...DEFAULT_RULE }] })
          }
        >
          <Plus size={11} />
          Agregar regla
        </button>
      </div>
    </React.Fragment>
  )

  return (
    <div>
      {config.branches.map((branch, branchIndex) => (
        <div key={branch.id || branchIndex} className={multiBranch ? styles.conditionBranch : undefined}>
          {multiBranch && (
            <div className={styles.conditionBranchHeader}>
              <Field label={`Rama ${branchIndex + 1}`}>
                <TextInput
                  value={branch.name}
                  placeholder="Nombre de la rama (ej. Clientes VIP)"
                  onChange={(event) => updateBranch(branchIndex, { name: event.target.value })}
                />
              </Field>
              <button
                type="button"
                className={styles.configIconButton}
                title="Quitar rama"
                onClick={() =>
                  onChange({ branches: config.branches.filter((_, index) => index !== branchIndex) })
                }
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}

          {branch.groups.map((group, groupIndex) => renderGroup(group, branchIndex, groupIndex, branch))}

          <button
            type="button"
            className={styles.configSmallButton}
            style={{ marginTop: 8 }}
            onClick={() => updateBranch(branchIndex, { groups: [...branch.groups, emptyConditionGroup()] })}
          >
            <Plus size={11} />
            Agregar grupo
          </button>
        </div>
      ))}

      {allowBranches && (
        <button
          type="button"
          className={styles.configSmallButton}
          style={{ marginTop: 10 }}
          disabled={config.branches.length >= MAX_BRANCHES - 1}
          onClick={() =>
            onChange({
              branches: [...config.branches, emptyConditionBranch(`Rama ${config.branches.length + 1}`)]
            })
          }
        >
          <Plus size={11} />
          Agregar rama
          {config.branches.length >= MAX_BRANCHES - 1 ? ' (máximo alcanzado)' : ''}
        </button>
      )}
    </div>
  )
}
