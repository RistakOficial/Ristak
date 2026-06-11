import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { CustomSelect } from '@/components/common'
import {
  CatalogSelect,
  ConfigSection,
  Field,
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
        <Field
          label="Enviar desde"
          help="Recomendado: responder por el mismo número donde el contacto te escribió"
        >
          <CustomSelect
            options={[
              { value: 'last-channel', label: 'El número donde te escribió el contacto (recomendado)' },
              { value: 'default', label: 'El número principal de tu cuenta' },
              { value: 'specific', label: 'Elegir un número específico…' }
            ]}
            value={str(config.sender) || 'last-channel'}
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
            <p className={styles.configHelp}>
              La plantilla ya incluye su idioma y sus variables configuradas: solo elígela y listo.
            </p>
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

    </div>
  )
}
