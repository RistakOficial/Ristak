import React, { useEffect, useState } from 'react'
import { AlertTriangle, ShieldAlert } from 'lucide-react'
import { CustomSelect } from './configPrimitives'
import {
  CatalogSelect,
  ConfigSection,
  Field,
  Toggle,
  useCatalogOptions
} from './configPrimitives'
import { MessageBlocksEditor } from './MessageBlocksEditor'
import { whatsappApiService } from '@/services/whatsappApiService'
import type { MessageBlock } from '../nodeRegistry'
import { genId } from '../flowUtils'
import styles from '../AutomationEditor.module.css'

/**
 * Configurador del nodo "WhatsApp / Enviar mensaje": remitente (número),
 * tipo de mensaje (normal o plantilla), variables y vista previa.
 */

type Config = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const newTemplateBlock = (): MessageBlock => ({
  id: genId('tpl'),
  type: 'template',
  templateId: '',
  templateName: ''
})

export const WhatsAppConfigEditor: React.FC<{ config: Config; onChange: (config: Config) => void }> = ({
  config,
  onChange
}) => {
  const set = (patch: Config) => onChange({ ...config, ...patch })
  const { options: numbers, loading: loadingNumbers } = useCatalogOptions('whatsappNumbers')
  const messageType = str(config.messageType) || 'text'
  const sendViaQr = config.sendViaQr === true || str(config.transport) === 'qr'
  const [hasQrConnected, setHasQrConnected] = useState(false)

  useEffect(() => {
    let mounted = true
    whatsappApiService.getStatus()
      .then((status) => {
        if (!mounted) return
        const phoneHasQr = (status.phoneNumbers || []).some((phone) => (
          phone.qr_send_enabled === true &&
          String(phone.qr_status || '').toLowerCase() === 'connected'
        ))
        const sessionHasQr = (status.qr?.sessions || []).some((session) => (
          String(session.status || '').toLowerCase() === 'connected'
        ))
        setHasQrConnected(phoneHasQr || sessionHasQr)
      })
      .catch(() => {
        if (mounted) setHasQrConnected(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  // Compatibilidad: si la config vieja solo tenía templateId, se ve como bloque
  const rawBlocks = Array.isArray(config.messageBlocks) ? (config.messageBlocks as MessageBlock[]) : []
  const templateBlocks =
    rawBlocks.some((block) => block.type === 'template') || !str(config.templateId)
      ? rawBlocks.filter((block) => block.type === 'template' || block.type === 'delay')
      : [
          {
            id: 'tpl_legacy',
            type: 'template' as const,
            templateId: str(config.templateId),
            templateName: str(config.templateName)
          }
        ]

  const firstTemplateBlock = (blocks: MessageBlock[]) => blocks.find((block) => block.type === 'template')

  const setTemplateBlocks = (messageBlocks: MessageBlock[]) => {
    const firstTemplate = firstTemplateBlock(messageBlocks)
    set({
      messageBlocks,
      templateId: str(firstTemplate?.templateId),
      templateName: str(firstTemplate?.templateName)
    })
  }

  const setMessageType = (next: string) => {
    if (next === 'template') {
      const nextBlocks = templateBlocks.some((block) => block.type === 'template')
        ? templateBlocks
        : [...templateBlocks, newTemplateBlock()]
      const firstTemplate = firstTemplateBlock(nextBlocks)
      set({
        messageType: 'template',
        messageBlocks: nextBlocks,
        templateId: str(firstTemplate?.templateId),
        templateName: str(firstTemplate?.templateName),
        sendViaQr: false,
        transport: 'api'
      })
      return
    }
    set({ messageType: next })
  }

  const setSendViaQr = (checked: boolean) => {
    set({
      sendViaQr: checked,
      transport: checked ? 'qr' : 'api'
    })
  }

  return (
    <div className={styles.whatsappConfig}>
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
            onValueChange={setMessageType}
            aria-label="Tipo de mensaje"
          />
        </Field>

        {messageType === 'text' && (
          <>
            <MessageBlocksEditor
              value={config.messageBlocks}
              onChange={(messageBlocks: MessageBlock[]) => set({ messageBlocks })}
              supportsQuickReplies={false}
              buttonLabelMaxLength={20}
            />

            {(hasQrConnected || sendViaQr) && (
              <div className={styles.qrModeBox}>
                <div className={styles.qrModeCopy}>
                  <div className={styles.qrModeTitle}>
                    <span
                      className={styles.qrRiskIcon}
                      title="Precaución: el envío por QR usa una aplicación de terceros no validada por Meta y puede aumentar el riesgo de bloqueo del número."
                    >
                      <ShieldAlert size={16} aria-hidden="true" />
                    </span>
                    Enviar mensajes normales por QR
                  </div>
                  <span className={styles.configHelp}>
                    Usa un número conectado por QR en lugar de WhatsApp API para estos mensajes. Actívalo sólo si aceptas el riesgo de bloqueo del número.
                  </span>
                </div>
                <Toggle
                  checked={sendViaQr}
                  onChange={setSendViaQr}
                  label="Activar QR"
                />
              </div>
            )}

            {sendViaQr && !hasQrConnected && (
              <div className={styles.configWarning}>
                <AlertTriangle size={12} />
                Esta automatización tiene QR activado, pero ahora no hay ningún número conectado por QR.
              </div>
            )}
          </>
        )}

        {messageType === 'template' && (
          <>
            <MessageBlocksEditor
              value={templateBlocks}
              onChange={setTemplateBlocks}
              variant="template"
            />
            <p className={styles.configHelp}>
              Cada plantilla ya incluye su idioma y sus variables: encadena varias con retrasos entre ellas si lo necesitas.
            </p>
          </>
        )}
      </ConfigSection>

      {/* ------------------------------- Preview ------------------------------ */}

    </div>
  )
}
