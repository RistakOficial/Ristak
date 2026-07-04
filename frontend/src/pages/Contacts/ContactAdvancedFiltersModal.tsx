import React, { useEffect, useMemo, useState } from 'react'
import { ListFilter, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button, CustomSelect, Modal } from '@/components/common'
import type { ContactCustomFieldDefinition } from '@/types'
import type { ContactTag } from '@/services/contactTagsService'
import styles from './Contacts.module.css'
import {
  CONTACT_ADVANCED_FIELD_GROUPS,
  CONTACT_ADVANCED_SORT_OPTIONS,
  contactAdvancedSortValue,
  countContactAdvancedRules,
  createContactAdvancedGroup,
  createContactAdvancedRule,
  getContactAdvancedField,
  getContactAdvancedOperators,
  getDefaultOperatorForContactAdvancedField,
  normalizeContactAdvancedConfig,
  operatorNeedsContactAdvancedValue,
  operatorUsesContactAdvancedRange,
  type ContactAdvancedFilterConfig,
  type ContactAdvancedGroup,
  type ContactAdvancedOperator,
  type ContactAdvancedRule
} from './contactAdvancedFilters'

interface ContactAdvancedFiltersModalProps {
  isOpen: boolean
  value: ContactAdvancedFilterConfig
  tags: ContactTag[]
  customFieldDefinitions: ContactCustomFieldDefinition[]
  onClose: () => void
  onApply: (config: ContactAdvancedFilterConfig) => void
}

const EMPTY_OPTION = { value: '', label: 'Selecciona' }

const customFieldKey = (field: ContactCustomFieldDefinition) =>
  field.definitionId || field.key || field.fieldKey || field.name || field.label

const customFieldLabel = (field: ContactCustomFieldDefinition) =>
  field.label || field.name || field.fieldKey || field.key || field.definitionId

const updateRule = (
  groups: ContactAdvancedGroup[],
  groupId: string,
  ruleId: string,
  updater: (rule: ContactAdvancedRule) => ContactAdvancedRule
) => groups.map(group => group.id === groupId
  ? { ...group, rules: group.rules.map(rule => rule.id === ruleId ? updater(rule) : rule) }
  : group
)

const scalarValue = (value: ContactAdvancedRule['value']) => {
  if (Array.isArray(value)) return value[0] || ''
  if (value === null || value === undefined) return ''
  return String(value)
}

export const ContactAdvancedFiltersModal: React.FC<ContactAdvancedFiltersModalProps> = ({
  isOpen,
  value,
  tags,
  customFieldDefinitions,
  onClose,
  onApply
}) => {
  const [draft, setDraft] = useState<ContactAdvancedFilterConfig>(() => normalizeContactAdvancedConfig(value))

  useEffect(() => {
    if (!isOpen) return
    const normalized = normalizeContactAdvancedConfig(value)
    setDraft({
      ...normalized,
      groups: normalized.groups.length > 0 ? normalized.groups : [createContactAdvancedGroup()]
    })
  }, [isOpen, value])

  const tagOptions = useMemo(() => [
    EMPTY_OPTION,
    ...tags.map(tag => ({ value: tag.id, label: tag.name }))
  ], [tags])

  const customFieldOptions = useMemo(() => [
    EMPTY_OPTION,
    ...customFieldDefinitions.map(field => ({
      value: customFieldKey(field),
      label: customFieldLabel(field)
    })).filter(option => option.value)
  ], [customFieldDefinitions])

  const activeRules = countContactAdvancedRules(draft)

  const setSort = (sortValue: string) => {
    const option = CONTACT_ADVANCED_SORT_OPTIONS.find(item => item.value === sortValue)
    setDraft(current => ({
      ...current,
      sort: option?.sort || null
    }))
  }

  const setGroupMode = (groupId: string, mode: 'all' | 'any') => {
    setDraft(current => ({
      ...current,
      groups: current.groups.map(group => group.id === groupId ? { ...group, mode } : group)
    }))
  }

  const toggleGroupNegate = (groupId: string) => {
    setDraft(current => ({
      ...current,
      groups: current.groups.map(group => group.id === groupId ? { ...group, negate: !group.negate } : group)
    }))
  }

  const addGroup = () => {
    setDraft(current => ({ ...current, groups: [...current.groups, createContactAdvancedGroup()] }))
  }

  const removeGroup = (groupId: string) => {
    setDraft(current => ({
      ...current,
      groups: current.groups.filter(group => group.id !== groupId)
    }))
  }

  const addRule = (groupId: string) => {
    setDraft(current => ({
      ...current,
      groups: current.groups.map(group => group.id === groupId
        ? { ...group, rules: [...group.rules, createContactAdvancedRule()] }
        : group
      )
    }))
  }

  const removeRule = (groupId: string, ruleId: string) => {
    setDraft(current => ({
      ...current,
      groups: current.groups.map(group => group.id === groupId
        ? { ...group, rules: group.rules.filter(rule => rule.id !== ruleId) }
        : group
      ).filter(group => group.rules.length > 0)
    }))
  }

  const setRuleField = (groupId: string, ruleId: string, fieldKey: string) => {
    const field = getContactAdvancedField(fieldKey)
    const operator = getDefaultOperatorForContactAdvancedField(field)
    setDraft(current => ({
      ...current,
      groups: updateRule(current.groups, groupId, ruleId, rule => ({
        ...rule,
        field: field?.key || 'full_name',
        operator,
        value: '',
        valueTo: '',
        customKey: ''
      }))
    }))
  }

  const setRuleOperator = (groupId: string, ruleId: string, operator: ContactAdvancedOperator) => {
    setDraft(current => ({
      ...current,
      groups: updateRule(current.groups, groupId, ruleId, rule => ({
        ...rule,
        operator,
        value: operatorNeedsContactAdvancedValue(operator) ? rule.value ?? '' : '',
        valueTo: operatorUsesContactAdvancedRange(operator) ? rule.valueTo ?? '' : ''
      }))
    }))
  }

  const setRulePatch = (groupId: string, ruleId: string, patch: Partial<ContactAdvancedRule>) => {
    setDraft(current => ({
      ...current,
      groups: updateRule(current.groups, groupId, ruleId, rule => ({ ...rule, ...patch }))
    }))
  }

  const resetDraft = () => {
    setDraft({ version: 1, groups: [createContactAdvancedGroup()], sort: null })
  }

  const applyDraft = () => {
    const normalized = normalizeContactAdvancedConfig({
      ...draft,
      groups: draft.groups
        .map(group => ({
          ...group,
          rules: group.rules.filter(rule => {
            const field = getContactAdvancedField(rule.field)
            if (!field) return false
            if (field.type === 'custom_field' && !rule.customKey) return false
            if (!operatorNeedsContactAdvancedValue(rule.operator)) return true
            if (operatorUsesContactAdvancedRange(rule.operator)) return Boolean(scalarValue(rule.value)) && Boolean(rule.valueTo)
            return Boolean(scalarValue(rule.value))
          })
        }))
        .filter(group => group.rules.length > 0)
    })

    onApply(normalized)
  }

  const renderValueInput = (groupId: string, rule: ContactAdvancedRule) => {
    const field = getContactAdvancedField(rule.field)
    if (!field || !operatorNeedsContactAdvancedValue(rule.operator)) {
      return <div className={styles.conditionValueNote}>Sin valor adicional</div>
    }

    const value = scalarValue(rule.value)
    const rangeValue = rule.valueTo === null || rule.valueTo === undefined ? '' : String(rule.valueTo)

    if (field.type === 'custom_field') {
      return (
        <div className={styles.conditionValuePair}>
          <CustomSelect
            value={rule.customKey || ''}
            onValueChange={(nextValue) => setRulePatch(groupId, rule.id, { customKey: nextValue })}
            options={customFieldOptions}
          />
          <input
            type="text"
            value={value}
            onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
            placeholder="Valor"
          />
        </div>
      )
    }

    if (field.type === 'tags') {
      return (
        <CustomSelect
          value={value}
          onValueChange={(nextValue) => setRulePatch(groupId, rule.id, { value: nextValue })}
          options={tagOptions}
        />
      )
    }

    if (field.type === 'select') {
      return (
        <CustomSelect
          value={value}
          onValueChange={(nextValue) => setRulePatch(groupId, rule.id, { value: nextValue })}
          options={[EMPTY_OPTION, ...(field.options || [])]}
        />
      )
    }

    if (field.type === 'date') {
      if (rule.operator === 'last_days' || rule.operator === 'older_days') {
        return (
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
            placeholder="30"
          />
        )
      }

      if (operatorUsesContactAdvancedRange(rule.operator)) {
        return (
          <div className={styles.conditionValuePair}>
            <input
              type="date"
              value={value}
              onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
            />
            <input
              type="date"
              value={rangeValue}
              onChange={(event) => setRulePatch(groupId, rule.id, { valueTo: event.target.value })}
            />
          </div>
        )
      }

      return (
        <input
          type="date"
          value={value}
          onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
        />
      )
    }

    if (field.type === 'number') {
      if (operatorUsesContactAdvancedRange(rule.operator)) {
        return (
          <div className={styles.conditionValuePair}>
            <input
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
              placeholder="0"
            />
            <input
              type="text"
              inputMode="decimal"
              value={rangeValue}
              onChange={(event) => setRulePatch(groupId, rule.id, { valueTo: event.target.value })}
              placeholder="0"
            />
          </div>
        )
      }

      return (
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
          placeholder="0"
        />
      )
    }

    return (
      <input
        type="text"
        value={value}
        onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
        placeholder="Valor"
      />
    )
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Condiciones de contactos"
      subtitle="Contactos, etiquetas, campos, citas, pagos y tracking."
      size="xl"
      contentClassName={styles.contactConditionsModalContent}
      closeOnBackdropClick={false}
    >
      <div className={styles.contactConditionsShell}>
        <div className={styles.contactConditionsTopbar}>
          <div className={styles.contactConditionsSummary}>
            <ListFilter size={16} />
            <span>{activeRules} condiciones</span>
          </div>
          <div className={styles.contactConditionsSort}>
            <span>Orden</span>
            <CustomSelect
              value={contactAdvancedSortValue(draft.sort)}
              onValueChange={setSort}
              options={CONTACT_ADVANCED_SORT_OPTIONS}
            />
          </div>
        </div>

        <div className={styles.contactConditionGroups}>
          {draft.groups.map((group, groupIndex) => (
            <section key={group.id} className={styles.contactConditionGroup}>
              <div className={styles.contactConditionGroupHeader}>
                <div className={styles.contactConditionGroupMeta}>
                  <span>Grupo {groupIndex + 1}</span>
                  <CustomSelect
                    value={group.mode}
                    onValueChange={(nextValue) => setGroupMode(group.id, nextValue === 'any' ? 'any' : 'all')}
                    options={[
                      { value: 'all', label: 'Todas se cumplen' },
                      { value: 'any', label: 'Cualquiera se cumple' }
                    ]}
                  />
                  <label className={styles.contactConditionToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(group.negate)}
                      onChange={() => toggleGroupNegate(group.id)}
                    />
                    <span>No se cumple</span>
                  </label>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Eliminar grupo"
                  onClick={() => removeGroup(group.id)}
                >
                  <Trash2 size={16} />
                </Button>
              </div>

              <div className={styles.contactConditionRules}>
                {group.rules.map(rule => {
                  const field = getContactAdvancedField(rule.field)
                  const operators = getContactAdvancedOperators(field)

                  return (
                    <div key={rule.id} className={styles.contactConditionRule}>
                      <CustomSelect
                        value={rule.field}
                        onValueChange={(nextValue) => setRuleField(group.id, rule.id, nextValue)}
                      >
                        {CONTACT_ADVANCED_FIELD_GROUPS.map(fieldGroup => (
                          <optgroup key={fieldGroup.label} label={fieldGroup.label}>
                            {fieldGroup.fields.map(item => (
                              <option key={item.key} value={item.key}>
                                {item.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </CustomSelect>
                      <CustomSelect
                        value={rule.operator}
                        onValueChange={(nextValue) => setRuleOperator(group.id, rule.id, nextValue as ContactAdvancedOperator)}
                        options={operators}
                      />
                      <div className={styles.contactConditionValue}>
                        {renderValueInput(group.id, rule)}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Eliminar condicion"
                        onClick={() => removeRule(group.id, rule.id)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  )
                })}
              </div>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => addRule(group.id)}
              >
                <Plus size={16} />
                Añadir condicion
              </Button>
            </section>
          ))}
        </div>

        <div className={styles.contactConditionsFooter}>
          <Button type="button" variant="secondary" onClick={addGroup}>
            <Plus size={16} />
            Añadir grupo
          </Button>
          <div className={styles.contactConditionsFooterActions}>
            <Button type="button" variant="ghost" onClick={resetDraft}>
              <RotateCcw size={16} />
              Limpiar
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="button" variant="primary" onClick={applyDraft}>
              Aplicar filtros
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
