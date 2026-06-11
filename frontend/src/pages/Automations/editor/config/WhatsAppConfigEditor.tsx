import React from 'react'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { CustomSelect } from '@/components/common'
import {
  CatalogSelect,
  ConfigSection,
  Field,
  TextInput,
  useCatalogOptions
} from './configPrimitives'
import { MessageBlocksEditor } from './MessageBlocksEditor'
import type { MessageBlock } from '../nodeRegistry'
import styles from '../AutomationEditor.module.css'

/**
 * Configurador del nodo "WhatsApp / Enviar mensaje": remitente (número),
 * tipo de mensaje (normal o plantilla), variables y vista previa.
 */

type Config = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export const WhatsAppConfigEditor: React.FC<{ config: Config; onChange: (config: Config) => void }> = ({
  config,
  onChange
}) => {
  const set = (patch: Config) => onChange({ ...config, ...patch })
  const { options: numbers, loading: loadingNumbers } = useCatalogOptions('whatsappNumbers')
  const messageType = str(config.messageType) || 'text'

  const templateVariables = Array.isArray(config.templateVariables)
    ? (config.templateVariables as Array<{ key?: string; value?: string }>)
    : []

  return (
    <div>
      {/* ------------------------------ Remitente ----------------------------- */}
      <ConfigSection title="Remitente">
        {!loadingNumbers && numbers.length === 0 && (
          <div className={styles.configWarning}>
            <AlertTriangle size={12} />
            No hay números de WhatsApp conectados. Conéctalos en Configuración → WhatsApp.
          </div>
        )}
        <Field label="Enviar desde">
          <CustomSelect
            options={[
              { value: 'last-channel', label: 'Último número por el que contactó el contacto' },
              { value: 'default', label: 'Número principal de la cuenta' },
              { value: 'specific', label: 'Número específico…' }
            ]}
            value={str(config.sender) || 'default'}
            onValueChange={(next) => set({ sender: next })}
            aria-label="Remitente"
          />
        </Field>
        {str(config.sender) === 'specific' && (
          <Field label="Número de WhatsApp">
            <CatalogSelect
              catalog="whatsappNumbers"
              value={str(config.senderNumberId)}
              onChange={(value, label) => set({ senderNumberId: value, senderNumberLabel: label })}
              placeholder="Selecciona el número"
              aria-label="Número de WhatsApp"
            />
          </Field>
        )}
      </ConfigSection>

      {/* --------------------------- Tipo de mensaje --------------------------- */}
      <ConfigSection title="Mensaje">
        <Field label="Tipo de mensaje">
          <CustomSelect
            options={[
              { value: 'text', label: 'Mensaje normal' },
              { value: 'template', label: 'Mensaje desde plantilla' }
            ]}
            value={messageType}
            onValueChange={(next) => set({ messageType: next })}
            aria-label="Tipo de mensaje"
          />
        </Field>

        {messageType === 'text' && (
          <MessageBlocksEditor
            value={config.messageBlocks}
            onChange={(messageBlocks: MessageBlock[]) => set({ messageBlocks })}
            supportsQuickReplies={false}
          />
        )}

        {messageType === 'template' && (
          <>
            <Field label="Plantilla">
              <CatalogSelect
                catalog="whatsappTemplates"
                value={str(config.templateId)}
                onChange={(value, label) => set({ templateId: value, templateName: label })}
                placeholder="Selecciona la plantilla aprobada"
                aria-label="Plantilla"
              />
            </Field>
            <Field label="Idioma de la plantilla">
              <TextInput
                value={str(config.templateLanguage)}
                placeholder="es_MX"
                onChange={(event) => set({ templateLanguage: event.target.value })}
              />
            </Field>
            <Field label="Variables de la plantilla">
              {templateVariables.map((variable, index) => (
                <div key={index} className={styles.configRow} style={{ marginBottom: 6 }}>
                  <TextInput
                    className={styles.configRowGrow}
                    placeholder={`{{${index + 1}}}`}
                    value={str(variable.key) || `{{${index + 1}}}`}
                    onChange={(event) => {
                      const next = templateVariables.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, key: event.target.value } : candidate
                      )
                      set({ templateVariables: next })
                    }}
                  />
                  <TextInput
                    className={styles.configRowGrow}
                    placeholder="Valor (ej. {{nombre}})"
                    value={str(variable.value)}
                    onChange={(event) => {
                      const next = templateVariables.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, value: event.target.value } : candidate
                      )
                      set({ templateVariables: next })
                    }}
                  />
                  <button
                    type="button"
                    className={styles.configIconButton}
                    title="Quitar variable"
                    onClick={() =>
                      set({ templateVariables: templateVariables.filter((_, candidateIndex) => candidateIndex !== index) })
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={styles.configSmallButton}
                onClick={() =>
                  set({
                    templateVariables: [
                      ...templateVariables,
                      { key: `{{${templateVariables.length + 1}}}`, value: '' }
                    ]
                  })
                }
              >
                <Plus size={11} />
                Agregar variable
              </button>
            </Field>
          </>
        )}
      </ConfigSection>

      {/* ------------------------------- Preview ------------------------------ */}
      {messageType === 'template' && str(config.templateName) && (
        <ConfigSection title="Vista previa">
          <div className={styles.waPreview}>
            <div className={styles.waPreviewBubble}>
              {`Plantilla: ${str(config.templateName)}${str(config.templateLanguage) ? ` (${str(config.templateLanguage)})` : ''}`}
            </div>
          </div>
        </ConfigSection>
      )}

      <Field label="Guardar respuesta en variable (opcional)">
        <TextInput
          value={str(config.saveAs)}
          placeholder="Ej. respuesta_whatsapp"
          onChange={(event) => set({ saveAs: event.target.value })}
        />
      </Field>
    </div>
  )
}
