import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Braces, ChevronDown, ChevronRight } from 'lucide-react'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null)
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
  const closePicker = useCallback(() => {
    setPickerOpen(false)
    setExpandedCategories(new Set())
    setPopoverStyle(null)
  }, [])

  const updatePopoverPosition = useCallback(() => {
    const root = rootRef.current
    if (!root || !pickerOpen) return

    const rect = root.getBoundingClientRect()
    const margin = 10
    const gap = 6
    const width = Math.min(320, window.innerWidth - margin * 2)
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const openBelow = spaceBelow >= 240 || spaceBelow > spaceAbove
    const availableHeight = Math.max(180, (openBelow ? spaceBelow : spaceAbove) - gap)

    setPopoverStyle({
      top: openBelow ? rect.bottom + gap : rect.top - gap,
      left,
      width,
      maxHeight: Math.min(340, availableHeight),
      ...(openBelow ? {} : { transform: 'translateY(-100%)' })
    })
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    updatePopoverPosition()
    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)
    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
    }
  }, [pickerOpen, updatePopoverPosition])

  useEffect(() => {
    if (!pickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        closePicker()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePicker()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [closePicker, pickerOpen])

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((current) => {
      const next = new Set(current)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  const togglePicker = () => {
    if (disabled || !hasVariables) return
    if (pickerOpen) {
      closePicker()
      return
    }
    setExpandedCategories(new Set())
    setPickerOpen(true)
  }

  const insertVariable = (fieldId: string) => {
    onChange(appendToken(value, fieldId))
    closePicker()
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const variablePopover = pickerOpen && popoverStyle && (
    <div
      ref={popoverRef}
      className={styles.popover}
      role="dialog"
      aria-label="Mapear variable"
      style={popoverStyle}
    >
      <div className={styles.popoverBody}>
        {groupedVariables.map(group => {
          const expanded = expandedCategories.has(group.category)
          return (
            <div key={group.category} className={styles.categoryGroup}>
              <button
                type="button"
                className={styles.categoryButton}
                aria-expanded={expanded}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => toggleCategory(group.category)}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{group.label}</span>
                <strong>{group.variables.length}</strong>
              </button>
              {expanded && (
                <div className={styles.variableList}>
                  {group.variables.map(variable => (
                    <button
                      key={variable.fieldId}
                      type="button"
                      className={styles.variableButton}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => insertVariable(variable.fieldId)}
                    >
                      <span>{variable.label}</span>
                      <small>{`{{${variable.fieldId}}}`}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  return (
    <div ref={rootRef} className={styles.root}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {hasVariables && (
        <button
          type="button"
          className={[styles.mapButton, pickerOpen ? styles.mapButtonActive : ''].filter(Boolean).join(' ')}
          disabled={disabled}
          aria-label="Mapear variable"
          aria-expanded={pickerOpen}
          title="Mapear variable"
          onPointerDown={(event) => event.preventDefault()}
          onClick={togglePicker}
        >
          <Braces size={14} />
        </button>
      )}
      {typeof document !== 'undefined' && variablePopover ? createPortal(variablePopover, document.body) : null}
    </div>
  )
}
