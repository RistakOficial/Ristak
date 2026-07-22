import React, { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { CustomSelect } from './configPrimitives'
import {
  CatalogSelect,
  ConfigSection,
  Field,
  useCatalogOptions
} from './configPrimitives'
import { MessageBlocksEditor } from './MessageBlocksEditor'
import { whatsappApiService } from '@/services/whatsappApiService'
import {
  getWhatsAppStatusConnectionAvailability,
  type WhatsAppConnectionAvailability
} from '@/utils/whatsappQrFallbackWarning'
import type { MessageBlock } from '../nodeRegistry'
import { genId } from '../flowUtils'
import styles from '../AutomationEditor.module.css'

/**
 * Configurador del nodo "WhatsApp / Enviar mensaje": remitente (número),
 * tipo de mensaje (normal o plantilla), variables y vista previa.
 */

type Config = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const defaultWhatsAppAvailability: WhatsAppConnectionAvailability = {
  hasApiConnected: false,
  hasQrConnected: false,
  canShowQrFallbackSwitch: false
}

const newTemplateBlock = (): MessageBlock => ({
  id: genId('tpl'),
  type: 'template',
  templateId: '',
  templateName: ''
})

const sanitizeTemplateBlock = (block: MessageBlock): MessageBlock => {
  if (block.type !== 'template') return block
  const cleanBlock = { ...block }
  delete cleanBlock.templateVariables
  delete cleanBlock.headerMediaUrl
  return cleanBlock
}

const isNormalWhatsAppBlock = (block: MessageBlock): boolean => block.type !== 'template'

export const WhatsAppConfigEditor: React.FC<{ config: Config; onChange: (config: Config) => void }> = ({
  config,
  onChange
}) => {
  const set = (patch: Config) => onChange({ ...config, ...patch })
  const { options: numbers, loading: loadingNumbers } = useCatalogOptions('whatsappNumbers')
  const messageType = str(config.messageType) || 'text'
  const [whatsappAvailability, setWhatsappAvailability] = useState<WhatsAppConnectionAvailability>(defaultWhatsAppAvailability)

  useEffect(() => {
    let mounted = true
    whatsappApiService.getStatus()
      .then((status) => {
        if (!mounted) return
        setWhatsappAvailability(getWhatsAppStatusConnectionAvailability(status))
      })
      .catch(() => {
        if (mounted) setWhatsappAvailability(defaultWhatsAppAvailability)
      })
    return () => {
      mounted = false
    }
  }, [])

  // Compatibilidad: si la config vieja solo tenía templateId, se ve como bloque
  const rawBlocks = Array.isArray(config.messageBlocks) ? (config.messageBlocks as MessageBlock[]) : []
  const normalBlocks = rawBlocks.filter(isNormalWhatsAppBlock)
  // Un flujo puede quedar deliberadamente sin bloques mientras el usuario el
  // arma. Nunca inyectamos un texto de reemplazo: imagen, video, audio, nota de
  // voz o archivo son mensajes válidos por sí solos y el bote de basura debe
  // realmente dejar el editor vacío en WhatsApp, Messenger e Instagram.
  const visibleNormalBlocks = normalBlocks
  const normalBlocksKey = rawBlocks.map((block) => `${block.id || ''}:${block.type}`).join('|')
  const templateMetaKey = `${str(config.templateId)}:${str(config.templateName)}`
  const templateBlocks =
    rawBlocks.some((block) => block.type === 'template') || !str(config.templateId)
      ? rawBlocks.filter((block) => block.type === 'template' || block.type === 'delay').map(sanitizeTemplateBlock)
      : [
          sanitizeTemplateBlock({
            id: 'tpl_legacy',
            type: 'template' as const,
            templateId: str(config.templateId),
            templateName: str(config.templateName)
          })
        ]

  const firstTemplateBlock = (blocks: MessageBlock[]) => blocks.find((block) => block.type === 'template')

  useEffect(() => {
    if (messageType !== 'text') return
    const hasTemplateBlock = rawBlocks.some((block) => block.type === 'template')
    const hasTemplateMeta = Boolean(str(config.templateId) || str(config.templateName))
    if (!hasTemplateBlock && !hasTemplateMeta) return

    onChange({
      ...config,
      messageBlocks: normalBlocks,
      templateId: '',
      templateName: ''
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageType, normalBlocksKey, templateMetaKey])

  const setNormalBlocks = (messageBlocks: MessageBlock[]) => {
    set({
      messageBlocks: messageBlocks.filter(isNormalWhatsAppBlock),
      templateId: '',
      templateName: ''
    })
  }

  const setTemplateBlocks = (messageBlocks: MessageBlock[]) => {
    const nextBlocks = messageBlocks.map(sanitizeTemplateBlock)
    const firstTemplate = firstTemplateBlock(nextBlocks)
    set({
      messageBlocks: nextBlocks,
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
        templateName: str(firstTemplate?.templateName)
      })
      return
    }
    set({
      messageType: next,
      messageBlocks: normalBlocks,
      templateId: '',
      templateName: ''
    })
  }

  const activeChannelNotice = whatsappAvailability.hasApiConnected && whatsappAvailability.hasQrConnected
    ? 'Canal automático: WhatsApp API sale primero. Si ese mismo número pierde la API, Ristak usa su conexión QR como respaldo.'
    : whatsappAvailability.hasQrConnected
      ? 'Canal automático: este mensaje se enviará por la conexión QR activa.'
      : whatsappAvailability.hasApiConnected
        ? 'Canal automático: este mensaje se enviará por WhatsApp API y usará plantilla oficial cuando corresponda.'
        : ''

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
              value={visibleNormalBlocks}
              onChange={setNormalBlocks}
              supportsQuickReplies={false}
              buttonLabelMaxLength={20}
              afterBlocks={activeChannelNotice ? <span className={styles.configHelp}>{activeChannelNotice}</span> : undefined}
            />
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
            {activeChannelNotice && <p className={styles.configHelp}>{activeChannelNotice}</p>}
          </>
        )}
      </ConfigSection>

      {/* ------------------------------- Preview ------------------------------ */}

    </div>
  )
}
