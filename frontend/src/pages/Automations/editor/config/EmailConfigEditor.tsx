import React, { useEffect, useMemo, useState } from 'react'
import { Edit3 } from 'lucide-react'
import {
  emailHtmlToPlainText,
  plainTextToEmailHtml,
  type EmailRichTextVariable,
  type EmailRichTextVariableCategory
} from '@/components/common'
import { Field } from './configPrimitives'
import { VariableCategoriesContext, VariableTextInput } from '../composer/MessageComposer'
import {
  BASE_VARIABLES,
  FlowVariablesContext,
  getVariablePickerCategories,
  loadAllVariables
} from '../variablesCatalog'
import styles from '../AutomationEditor.module.css'

type ConfigValue = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export interface EmailRichEditorRequest {
  subject: string
  body: string
  bodyHtml: string
  includeSignature: boolean
  variables: EmailRichTextVariable[]
  variableCategories: EmailRichTextVariableCategory[]
}

interface EmailConfigEditorProps {
  config: ConfigValue
  onChange: (config: ConfigValue) => void
  onOpenRichEditor: (request: EmailRichEditorRequest) => void
}

export const EmailConfigEditor: React.FC<EmailConfigEditorProps> = ({ config, onChange, onOpenRichEditor }) => {
  const flowVariables = React.useContext(FlowVariablesContext)
  const allowedCategories = React.useContext(VariableCategoriesContext)
  const [variables, setVariables] = useState(BASE_VARIABLES)
  const setValue = (key: string, value: unknown) => onChange({ ...config, [key]: value })

  useEffect(() => {
    let cancelled = false
    void loadAllVariables().then((loaded) => {
      if (!cancelled) setVariables(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const richEditorVariables = useMemo<EmailRichTextVariable[]>(() => {
    const byId = new Map<string, EmailRichTextVariable>()
    ;[...variables, ...flowVariables.variables].forEach((variable) => {
      if (!variable.fieldId) return
      byId.set(variable.fieldId, {
        value: variable.fieldId,
        label: variable.label,
        category: variable.category,
        categoryLabel: variable.categoryLabel,
        pathLabels: variable.pathLabels,
        path: variable.path,
        hiddenFromPicker: variable.hiddenFromPicker
      })
    })
    return Array.from(byId.values())
  }, [flowVariables.variables, variables])
  const richEditorVariableCategories = useMemo<EmailRichTextVariableCategory[]>(
    () => getVariablePickerCategories(allowedCategories, flowVariables.categories),
    [allowedCategories, flowVariables.categories]
  )

  const body = str(config.body)
  const bodyHtml = str(config.bodyHtml) || plainTextToEmailHtml(body)
  const bodyPreview = (emailHtmlToPlainText(bodyHtml) || body).trim()
  const includeSignature = bool(config.includeSignature, true)

  return (
    <>
      <Field
        label="Para"
        help="Se usará el correo del contacto. Puedes cambiarlo con una variable si este flujo necesita otro destinatario."
      >
        <VariableTextInput
          value={str(config.toEmail) || '{{contact.email}}'}
          onChange={(value) => setValue('toEmail', value)}
          placeholder="{{contact.email}}"
          aria-label="Destinatario del correo"
        />
      </Field>

      <Field label="Asunto">
        <VariableTextInput
          value={str(config.subject)}
          onChange={(value) => setValue('subject', value)}
          placeholder="Asunto del correo"
          aria-label="Asunto del correo"
        />
      </Field>

      <Field label="Mensaje">
        <button
          type="button"
          className={styles.emailEditorTrigger}
          data-empty={bodyPreview ? undefined : 'true'}
          onClick={() =>
            onOpenRichEditor({
              subject: str(config.subject),
              body,
              bodyHtml,
              includeSignature,
              variables: richEditorVariables,
              variableCategories: richEditorVariableCategories
            })
          }
        >
          <span className={styles.emailEditorTriggerTop}>
            <span>{bodyPreview ? 'Correo preparado' : 'Editar contenido del correo'}</span>
            <Edit3 size={15} />
          </span>
          <span className={styles.emailEditorPreview}>
            {bodyPreview || 'Abre el editor para escribir el correo con formato, HTML, imágenes y firma.'}
          </span>
          <span className={styles.emailEditorHint}>
            {includeSignature ? 'Firma guardada incluida al enviar.' : 'Firma guardada desactivada para este correo.'}
          </span>
        </button>
      </Field>
    </>
  )
}
