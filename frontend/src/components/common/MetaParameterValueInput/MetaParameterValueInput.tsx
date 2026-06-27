import React, { useMemo } from 'react'
import { CustomSelect } from '../CustomSelect'
import styles from './MetaParameterValueInput.module.css'

export interface MetaParameterVariable {
  fieldId: string
  label: string
  category: string
  categoryLabel?: string
}

interface MetaParameterValueInputProps {
  value: string
  placeholder?: string
  disabled?: boolean
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  variables?: MetaParameterVariable[]
  onChange: (value: string) => void
  onBlur?: React.FocusEventHandler<HTMLInputElement>
}

const categoryFallbackLabels: Record<string, string> = {
  contact: 'Contacto',
  custom: 'Campos personalizados',
  variable: 'Campos del sistema',
  form: 'Formulario',
  appointment: 'Cita',
  payment: 'Pago',
  conversation: 'Conversación',
  automation: 'Automatización'
}

const appendToken = (currentValue: string, fieldId: string) => {
  const token = `{{${fieldId}}}`
  const current = String(currentValue || '')
  if (!current.trim()) return token
  if (current.endsWith(' ') || current.endsWith('\n')) return `${current}${token}`
  return `${current} ${token}`
}

export const MetaParameterValueInput: React.FC<MetaParameterValueInputProps> = ({
  value,
  placeholder,
  disabled,
  inputMode,
  variables = [],
  onChange,
  onBlur
}) => {
  const groupedVariables = useMemo(() => {
    const groups = new Map<string, { label: string; variables: MetaParameterVariable[] }>()
    variables.forEach((variable) => {
      if (!variable.fieldId) return
      const group = groups.get(variable.category) || {
        label: variable.categoryLabel || categoryFallbackLabels[variable.category] || variable.category,
        variables: []
      }
      if (!group.variables.some(candidate => candidate.fieldId === variable.fieldId)) {
        group.variables.push(variable)
      }
      groups.set(variable.category, group)
    })
    return [...groups.entries()].map(([category, group]) => ({
      category,
      label: group.label,
      variables: group.variables.sort((left, right) => left.label.localeCompare(right.label, 'es'))
    }))
  }, [variables])

  const hasVariables = groupedVariables.some(group => group.variables.length > 0)

  return (
    <div className={styles.root}>
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {hasVariables && (
        <CustomSelect
          value=""
          disabled={disabled}
          portal
          className={styles.variableSelect}
          aria-label="Mapear variable"
          onChange={(event) => {
            const fieldId = event.target.value
            if (!fieldId) return
            onChange(appendToken(value, fieldId))
          }}
        >
          <option value="">Mapear</option>
          {groupedVariables.map(group => (
            <optgroup key={group.category} label={group.label}>
              {group.variables.map(variable => (
                <option key={variable.fieldId} value={variable.fieldId}>
                  {variable.label}
                </option>
              ))}
            </optgroup>
          ))}
        </CustomSelect>
      )}
    </div>
  )
}
