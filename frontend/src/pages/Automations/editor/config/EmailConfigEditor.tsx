import React from 'react'
import { Field } from './configPrimitives'
import { MessageComposer, VariableTextInput } from '../composer/MessageComposer'

type ConfigValue = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

interface EmailConfigEditorProps {
  config: ConfigValue
  onChange: (config: ConfigValue) => void
}

export const EmailConfigEditor: React.FC<EmailConfigEditorProps> = ({ config, onChange }) => {
  const setValue = (key: string, value: string) => onChange({ ...config, [key]: value })

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
        <MessageComposer
          value={str(config.body)}
          onChange={(value) => setValue('body', value)}
          placeholder="Escribe el correo..."
          showEmoji={false}
          aria-label="Mensaje del correo"
        />
      </Field>
    </>
  )
}
