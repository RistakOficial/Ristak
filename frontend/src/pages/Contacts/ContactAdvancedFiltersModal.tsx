import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListFilter, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { Button, CustomSelect, SearchField } from '@/components/common'
import type { ContactCustomFieldDefinition } from '@/types'
import type { ContactTag } from '@/services/contactTagsService'
import { globalSearchService, type GlobalSearchItem, type GlobalSearchItemType } from '@/services/globalSearchService'
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
  type ContactAdvancedField,
  type ContactAdvancedGroup,
  type ContactAdvancedOperator,
  type ContactAdvancedOption,
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

type FieldPickerTarget =
  | { type: 'newGroup' }
  | { type: 'newRule'; groupId: string }
  | { type: 'existingRule'; groupId: string; ruleId: string }

interface ContactFilterFieldChoice {
  id: string
  fieldKey: string
  label: string
  type: ContactAdvancedField['type']
  groupLabel: string
  options?: ContactAdvancedField['options']
  catalog?: ContactAdvancedField['catalog']
  placeholder?: ContactAdvancedField['placeholder']
  customKey?: string
  searchText: string
}

const EMPTY_OPTION = { value: '', label: 'Selecciona' }

const groupModeOptions = [
  { value: 'all', label: 'Todos los bloques deben coincidir' },
  { value: 'any', label: 'Con que coincida un bloque' }
]

const catalogTypeByFieldCatalog: Record<NonNullable<ContactAdvancedField['catalog']>, GlobalSearchItemType> = {
  campaigns: 'campaign',
  adsets: 'adset',
  ads: 'ad',
  automations: 'automation',
  calendars: 'calendar',
  users: 'user',
  payments: 'payment',
  payment_plans: 'payment_plan'
}

const customFieldKey = (field: ContactCustomFieldDefinition) =>
  String(field.definitionId || field.key || field.fieldKey || field.name || field.label || '').trim()

const customFieldLabel = (field: ContactCustomFieldDefinition) =>
  String(field.label || field.name || field.fieldKey || field.key || field.definitionId || 'Campo personalizado').trim()

const getCustomFieldOptionValue = (option: unknown) => {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return String(option || '').trim()
  const raw = option as { value?: unknown; label?: unknown; name?: unknown }
  return String(raw.value || raw.label || raw.name || '').trim()
}

const getCustomFieldOptionLabel = (option: unknown) => {
  if (!option || typeof option !== 'object' || Array.isArray(option)) return String(option || '').trim()
  const raw = option as { label?: unknown; name?: unknown; value?: unknown }
  return String(raw.label || raw.name || raw.value || '').trim()
}

const getCustomFieldSelectOptions = (field?: Partial<ContactCustomFieldDefinition>): ContactAdvancedOption[] => {
  if (!field || !Array.isArray(field.options)) return []
  return field.options
    .map(option => ({
      value: getCustomFieldOptionValue(option),
      label: getCustomFieldOptionLabel(option)
    }))
    .filter(option => option.value && option.label)
}

const getCustomFieldAdvancedType = (field?: Partial<ContactCustomFieldDefinition>): ContactAdvancedField['type'] => {
  const options = getCustomFieldSelectOptions(field)
  if (options.length > 0) return 'select'

  const dataType = String(field?.dataType || '').trim().toLowerCase()
  if (['number', 'currency', 'decimal', 'integer'].includes(dataType)) return 'number'
  if (['date', 'datetime', 'date_time'].includes(dataType)) return 'date'
  if (['checkbox', 'boolean', 'switch', 'yes_no'].includes(dataType)) return 'boolean'
  return 'text'
}

const fieldFromChoice = (choice: ContactFilterFieldChoice): ContactAdvancedField => ({
  key: choice.fieldKey,
  label: choice.label,
  type: choice.type,
  options: choice.options,
  catalog: choice.catalog,
  placeholder: choice.placeholder
})

const isCatalogIdField = (fieldKey: string) => (
  fieldKey.endsWith('_id') ||
  fieldKey === 'attribution_ad_id' ||
  fieldKey === 'appointment_calendar' ||
  fieldKey === 'appointment_assigned_user'
)

const optionFromCatalogItem = (field: ContactAdvancedField, item: GlobalSearchItem): ContactAdvancedOption => ({
  value: isCatalogIdField(field.key) ? item.id : item.title || item.id,
  label: item.title && item.id && item.title !== item.id ? `${item.title} · ${item.id}` : item.title || item.id
})

const ContactCatalogValueInput: React.FC<{
  field: ContactAdvancedField
  value: string
  onChange: (value: string) => void
}> = ({ field, value, onChange }) => {
  const [term, setTerm] = useState(value)
  const [results, setResults] = useState<ContactAdvancedOption[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    setTerm(value)
  }, [value])

  useEffect(() => {
    const query = term.trim()
    const catalog = field.catalog
    if (!catalog || query.length < 2) {
      setResults([])
      setIsLoading(false)
      return undefined
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setIsLoading(true)
      globalSearchService.search(query, controller.signal)
        .then(response => {
          const expectedType = catalogTypeByFieldCatalog[catalog]
          const options = response.categories
            .flatMap(category => category.items)
            .filter(item => item.type === expectedType)
            .map(item => optionFromCatalogItem(field, item))

          setResults(options)
          setIsOpen(options.length > 0)
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([])
            setIsOpen(false)
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false)
        })
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [field.catalog, field.key, term])

  return (
    <div className={styles.conditionCatalogInput}>
      <SearchField
        value={term}
        onChange={(nextValue) => {
          setTerm(nextValue)
          onChange(nextValue)
        }}
        onClear={() => {
          setTerm('')
          setResults([])
          setIsOpen(false)
          onChange('')
        }}
        onFocus={() => setIsOpen(results.length > 0)}
        placeholder={field.placeholder || 'Buscar'}
        loading={isLoading}
        size="sm"
      />
      {isOpen && results.length > 0 && (
        <div className={styles.conditionCatalogResults}>
          {results.map(option => (
            <button
              key={`${option.value}-${option.label}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setTerm(option.value)
                setIsOpen(false)
                onChange(option.value)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

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

const choiceIdForRule = (rule: ContactAdvancedRule) =>
  rule.field === 'custom_field' && rule.customKey ? `custom:${rule.customKey}` : rule.field

const fieldTypeLabel = (type: ContactAdvancedField['type']) => {
  if (type === 'date') return 'Fecha'
  if (type === 'number') return 'Número'
  if (type === 'boolean') return 'Sí / No'
  if (type === 'select') return 'Lista'
  if (type === 'tags') return 'Etiquetas'
  if (type === 'custom_field') return 'Campo personalizado'
  return 'Texto'
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
  const [fieldSearchTerm, setFieldSearchTerm] = useState('')
  const [fieldPickerTarget, setFieldPickerTarget] = useState<FieldPickerTarget | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const normalized = normalizeContactAdvancedConfig(value)
    setDraft(normalized)
    setFieldSearchTerm('')
    setFieldPickerTarget(normalized.groups.length > 0 ? null : { type: 'newGroup' })
  }, [isOpen, value])

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose])

  const fieldChoices = useMemo<ContactFilterFieldChoice[]>(() => {
    const activeCustomFields = customFieldDefinitions.filter(field => !field.archived)
    const includeGenericCustomField = activeCustomFields.length === 0

    const staticChoices = CONTACT_ADVANCED_FIELD_GROUPS.flatMap(fieldGroup => fieldGroup.fields.flatMap(field => {
      if (field.key === 'custom_field' && !includeGenericCustomField) return []
      return [{
        id: field.key,
        fieldKey: field.key,
        label: field.label,
        type: field.type,
        options: field.options,
        catalog: field.catalog,
        placeholder: field.placeholder,
        groupLabel: fieldGroup.label,
        searchText: [field.label, fieldGroup.label, field.key, fieldTypeLabel(field.type)].join(' ').toLowerCase()
      }]
    }))

    const customChoices = activeCustomFields.flatMap(field => {
      const key = customFieldKey(field)
      if (!key) return []
      const label = customFieldLabel(field)
      const groupLabel = field.folderName || field.fieldGroup || 'Campos personalizados'
      const type = getCustomFieldAdvancedType(field)
      const options = getCustomFieldSelectOptions(field)
      return [{
        id: `custom:${key}`,
        fieldKey: 'custom_field',
        label,
        type,
        options: options.length > 0 ? options : undefined,
        customKey: key,
        groupLabel,
        searchText: [
          label,
          groupLabel,
          key,
          field.description,
          field.dataType,
          fieldTypeLabel(type),
          field.sourceFormName,
          field.sourceFieldName,
          field.sourceLabel,
          'campo personalizado'
        ].filter(Boolean).join(' ').toLowerCase()
      }]
    })

    return [...staticChoices, ...customChoices]
  }, [customFieldDefinitions])

  const choiceById = useMemo(() => new Map(fieldChoices.map(choice => [choice.id, choice])), [fieldChoices])
  const customFieldDefinitionByKey = useMemo(() => {
    const definitions = new Map<string, ContactCustomFieldDefinition>()
    customFieldDefinitions.forEach(field => {
      [
        field.definitionId,
        field.key,
        field.fieldKey,
        field.name,
        field.label
      ].forEach(rawKey => {
        const key = String(rawKey || '').trim()
        if (key) definitions.set(key, field)
      })
    })
    return definitions
  }, [customFieldDefinitions])

  const filteredFieldGroups = useMemo(() => {
    const query = fieldSearchTerm.trim().toLowerCase()
    const groups = new Map<string, ContactFilterFieldChoice[]>()

    fieldChoices.forEach(choice => {
      if (query && !choice.searchText.includes(query)) return
      const items = groups.get(choice.groupLabel) || []
      items.push(choice)
      groups.set(choice.groupLabel, items)
    })

    return Array.from(groups.entries()).map(([label, fields]) => ({ label, fields }))
  }, [fieldChoices, fieldSearchTerm])

  const tagOptions = useMemo(() => [
    EMPTY_OPTION,
    ...tags.map(tag => ({ value: tag.id, label: tag.name }))
  ], [tags])

  const customFieldOptions = useMemo(() => [
    EMPTY_OPTION,
    ...customFieldDefinitions
      .filter(field => !field.archived)
      .map(field => ({
        value: customFieldKey(field),
        label: customFieldLabel(field)
      }))
      .filter(option => option.value)
  ], [customFieldDefinitions])

  const activeRules = countContactAdvancedRules(draft)
  const isFieldPickerVisible = Boolean(fieldPickerTarget) || draft.groups.length === 0
  const groupJoinLabel = draft.groupMode === 'any' ? 'O' : 'Y'
  const activeRulesLabel = activeRules === 1 ? '1 condición activa' : `${activeRules} condiciones activas`
  const builderRulesLabel = activeRules === 1 ? '1 condición' : `${activeRules} condiciones`
  const availableFieldsLabel = fieldChoices.length === 1 ? '1 campo disponible' : `${fieldChoices.length} campos disponibles`

  const choiceForRule = (rule: ContactAdvancedRule) => {
    if (rule.field === 'custom_field' && rule.customKey) {
      const customDefinition = customFieldDefinitionByKey.get(rule.customKey)
      if (customDefinition) {
        const type = getCustomFieldAdvancedType(customDefinition)
        const options = getCustomFieldSelectOptions(customDefinition)
        const groupLabel = customDefinition.folderName || customDefinition.fieldGroup || 'Campos personalizados'
        return {
          id: `custom:${rule.customKey}`,
          fieldKey: 'custom_field',
          label: customFieldLabel(customDefinition),
          type,
          options: options.length > 0 ? options : undefined,
          customKey: rule.customKey,
          groupLabel,
          searchText: ''
        } as ContactFilterFieldChoice
      }
    }

    const selected = choiceById.get(choiceIdForRule(rule))
    if (selected) return selected
    const field = getContactAdvancedField(rule.field)
    return {
      id: rule.field || 'full_name',
      fieldKey: field?.key || 'full_name',
      label: field?.label || 'Campo',
      type: field?.type || 'text',
      options: field?.options,
      catalog: field?.catalog,
      placeholder: field?.placeholder,
      groupLabel: 'Contacto',
      searchText: ''
    } as ContactFilterFieldChoice
  }

  const fieldForRule = (rule: ContactAdvancedRule): ContactAdvancedField | undefined => {
    const baseField = getContactAdvancedField(rule.field)
    if (!baseField) return undefined
    const choice = choiceForRule(rule)
    if (rule.field !== 'custom_field') {
      return {
        ...baseField,
        label: choice.label || baseField.label,
        options: choice.options || baseField.options,
        catalog: choice.catalog || baseField.catalog,
        placeholder: choice.placeholder || baseField.placeholder
      }
    }
    return {
      ...baseField,
      label: choice.label || baseField.label,
      type: choice.type,
      options: choice.options,
      placeholder: choice.placeholder
    }
  }

  const createRuleForChoice = (choice: ContactFilterFieldChoice) => {
    const field = fieldFromChoice(choice)
    const rule = createContactAdvancedRule(choice.fieldKey)
    return {
      ...rule,
      field: field?.key || choice.fieldKey,
      operator: getDefaultOperatorForContactAdvancedField(field),
      value: '',
      valueTo: '',
      customKey: choice.customKey || '',
      valueType: choice.fieldKey === 'custom_field' ? choice.type : undefined
    }
  }

  const setSort = (sortValue: string) => {
    const option = CONTACT_ADVANCED_SORT_OPTIONS.find(item => item.value === sortValue)
    setDraft(current => ({
      ...current,
      sort: option?.sort || null
    }))
  }

  const setConfigGroupMode = (mode: string) => {
    setDraft(current => ({
      ...current,
      groupMode: mode === 'any' ? 'any' : 'all'
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

  const openFieldPicker = (target: FieldPickerTarget) => {
    setFieldSearchTerm('')
    setFieldPickerTarget(target)
  }

  const selectFieldChoice = (choice: ContactFilterFieldChoice) => {
    const nextRule = createRuleForChoice(choice)
    const target = fieldPickerTarget || { type: 'newGroup' as const }

    setDraft(current => {
      if (target.type === 'existingRule') {
        return {
          ...current,
          groups: updateRule(current.groups, target.groupId, target.ruleId, () => nextRule)
        }
      }

      if (target.type === 'newRule') {
        return {
          ...current,
          groups: current.groups.map(group => group.id === target.groupId
            ? { ...group, rules: [...group.rules, nextRule] }
            : group
          )
        }
      }

      const group = createContactAdvancedGroup(choice.fieldKey)
      return {
        ...current,
        groups: [
          ...current.groups,
          {
            ...group,
            rules: [nextRule]
          }
        ]
      }
    })

    setFieldSearchTerm('')
    setFieldPickerTarget(null)
  }

  const removeGroup = (groupId: string) => {
    setDraft(current => ({
      ...current,
      groups: current.groups.filter(group => group.id !== groupId)
    }))
    setFieldPickerTarget(current => current && 'groupId' in current && current.groupId === groupId ? null : current)
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
    setDraft({ version: 1, groupMode: 'all', groups: [], sort: null })
    setFieldSearchTerm('')
    setFieldPickerTarget({ type: 'newGroup' })
  }

  const applyDraft = () => {
    const normalized = normalizeContactAdvancedConfig({
      ...draft,
      groupMode: draft.groupMode === 'any' ? 'any' : 'all',
      groups: draft.groups
        .map(group => ({
          ...group,
          rules: group.rules.map(rule => {
            const field = fieldForRule(rule)
            return {
              ...rule,
              valueType: rule.field === 'custom_field' ? field?.type : undefined
            }
          }).filter(rule => {
            const field = fieldForRule(rule)
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
    const field = fieldForRule(rule)
    if (!field || !operatorNeedsContactAdvancedValue(rule.operator)) {
      return <div className={styles.conditionValueNote}>No pide valor</div>
    }

    const value = scalarValue(rule.value)
    const rangeValue = rule.valueTo === null || rule.valueTo === undefined ? '' : String(rule.valueTo)

    if (rule.field === 'custom_field' && !rule.customKey) {
      return (
        <div className={styles.conditionValuePair}>
          <CustomSelect
            value={rule.customKey || ''}
            onValueChange={(nextValue) => {
              const customDefinition = customFieldDefinitionByKey.get(nextValue)
              const customFieldType = getCustomFieldAdvancedType(customDefinition)
              setRulePatch(groupId, rule.id, {
                customKey: nextValue,
                operator: getDefaultOperatorForContactAdvancedField({
                  key: 'custom_field',
                  label: customDefinition ? customFieldLabel(customDefinition) : 'Campo personalizado',
                  type: customFieldType,
                  options: getCustomFieldSelectOptions(customDefinition)
                }),
                value: '',
                valueTo: '',
                valueType: customFieldType
              })
            }}
            options={customFieldOptions}
          />
          <input
            type="text"
            value={value}
            onChange={(event) => setRulePatch(groupId, rule.id, { value: event.target.value })}
            placeholder="Escribe el valor"
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

    if (field.catalog) {
      return (
        <ContactCatalogValueInput
          field={field}
          value={value}
          onChange={(nextValue) => setRulePatch(groupId, rule.id, { value: nextValue })}
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
        placeholder={field.placeholder || 'Escribe el valor'}
      />
    )
  }

  const renderFieldPicker = () => (
    <div className={styles.contactFilterPicker}>
      <div className={styles.contactFilterPickerHeader}>
        <div>
          <span>Elige qué quieres filtrar</span>
          <span>{availableFieldsLabel}</span>
        </div>
        {draft.groups.length > 0 && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setFieldPickerTarget(null)}>
            Volver
          </Button>
        )}
      </div>

      <SearchField
        value={fieldSearchTerm}
        onChange={setFieldSearchTerm}
        onClear={() => setFieldSearchTerm('')}
        placeholder="Buscar por nombre del campo"
        className={styles.contactFieldFinder}
        size="md"
      />

      <div className={styles.contactFilterFieldGroups}>
        {filteredFieldGroups.length === 0 ? (
          <div className={styles.contactFilterEmptyState}>No hay campos con ese nombre.</div>
        ) : filteredFieldGroups.map(fieldGroup => (
          <section key={fieldGroup.label} className={styles.contactFilterFieldGroup}>
            <span>{fieldGroup.label}</span>
            <div className={styles.contactFilterFieldList}>
              {fieldGroup.fields.map(choice => (
                <Button
                  key={choice.id}
                  type="button"
                  variant="ghost"
                  fullWidth
                  className={styles.contactFilterFieldButton}
                  onClick={() => selectFieldChoice(choice)}
                >
                  <span className={styles.contactFilterFieldCopy}>
                    <span>{choice.label}</span>
                    <span>{fieldTypeLabel(choice.type)}</span>
                  </span>
                </Button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )

  const renderBuilder = () => (
    <div className={styles.contactConditionsBuilder}>
      <div className={styles.contactConditionsTopbar}>
        <div className={styles.contactConditionsSummary}>
          <ListFilter size={16} />
          <span>{builderRulesLabel}</span>
        </div>
        <div className={styles.contactConditionsToolbar}>
          <div className={styles.contactConditionsSort}>
            <span>Cómo combinar</span>
            <CustomSelect
              value={draft.groupMode || 'all'}
              onValueChange={setConfigGroupMode}
              options={groupModeOptions}
            />
          </div>
          <div className={styles.contactConditionsSort}>
            <span>Ordenar</span>
            <CustomSelect
              value={contactAdvancedSortValue(draft.sort)}
              onValueChange={setSort}
              options={CONTACT_ADVANCED_SORT_OPTIONS}
            />
          </div>
        </div>
      </div>

      <div className={styles.contactConditionGroups}>
        {draft.groups.map((group, groupIndex) => (
          <React.Fragment key={group.id}>
            {groupIndex > 0 && (
              <div className={styles.contactConditionGroupJoiner}>
                <span>{groupJoinLabel}</span>
              </div>
            )}
            <section className={styles.contactConditionGroup}>
              <div className={styles.contactConditionGroupHeader}>
                <div className={styles.contactConditionGroupMeta}>
                  <span>Bloque {groupIndex + 1}</span>
                  <CustomSelect
                    value={group.mode}
                    onValueChange={(nextValue) => setGroupMode(group.id, nextValue === 'any' ? 'any' : 'all')}
                    options={[
                      { value: 'all', label: 'Todas estas condiciones' },
                      { value: 'any', label: 'Cualquiera de estas condiciones' }
                    ]}
                  />
                  <label className={styles.contactConditionToggle}>
                    <input
                      type="checkbox"
                      checked={Boolean(group.negate)}
                      onChange={() => toggleGroupNegate(group.id)}
                    />
                    <span>Excluir a quienes cumplan esto</span>
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
                  const field = fieldForRule(rule)
                  const operators = getContactAdvancedOperators(field)
                  const choice = choiceForRule(rule)

                  return (
                    <div key={rule.id} className={styles.contactConditionRule}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.contactConditionFieldButton}
                        onClick={() => openFieldPicker({ type: 'existingRule', groupId: group.id, ruleId: rule.id })}
                      >
                        <span>{choice.label}</span>
                        <Pencil size={14} />
                      </Button>
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
                        aria-label="Eliminar condición"
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
                onClick={() => openFieldPicker({ type: 'newRule', groupId: group.id })}
              >
                <Plus size={16} />
                Agregar otra condición
              </Button>
            </section>
          </React.Fragment>
        ))}
      </div>

      <Button type="button" variant="secondary" onClick={() => openFieldPicker({ type: 'newGroup' })}>
        <Plus size={16} />
        Agregar otro bloque
      </Button>
    </div>
  )

  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <div
      className={styles.contactFilterDrawerBackdrop}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <aside
        className={styles.contactFilterDrawer}
        role="dialog"
        aria-modal="true"
        data-floating-modal-root="true"
        aria-label="Filtros avanzados"
      >
        <header className={styles.contactFilterDrawerHeader}>
          <div>
            <h2>Filtros avanzados</h2>
            <span>{activeRulesLabel}</span>
          </div>
          <Button type="button" variant="ghost" size="sm" iconOnly aria-label="Cerrar filtros" onClick={onClose}>
            <X size={18} />
          </Button>
        </header>

        <div className={styles.contactFilterDrawerBody}>
          {isFieldPickerVisible ? renderFieldPicker() : renderBuilder()}
        </div>

        <footer className={styles.contactFilterDrawerFooter}>
          <Button type="button" variant="ghost" onClick={resetDraft}>
            <RotateCcw size={16} />
            Borrar todos los filtros
          </Button>
          <div className={styles.contactFilterDrawerActions}>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="button" variant="primary" onClick={applyDraft}>
              Aplicar
            </Button>
          </div>
        </footer>
      </aside>
    </div>,
    document.body
  )
}
