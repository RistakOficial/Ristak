import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, Loader2, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { CustomSelect } from './config/configPrimitives'
import { validateNodeConfig, type ConfigField, type NodeDefinition } from './nodeRegistry'
import { genId } from './flowUtils'
import {
  CatalogSelect,
  CatalogTags,
  DurationInput,
  Field,
  TextArea,
  TextInput,
  Toggle,
  WeekdaysPicker
} from './config/configPrimitives'
import { AdvancedConditionBuilder } from './config/AdvancedConditionBuilder'
import { WaitConfigEditor } from './config/WaitConfigEditor'
import { GoalConfigEditor } from './config/GoalConfigEditor'
import { WhatsAppConfigEditor } from './config/WhatsAppConfigEditor'
import { MessageBlocksEditor } from './config/MessageBlocksEditor'
import { TriggerFiltersEditor } from './config/TriggerFiltersEditor'
import type { TriggerFilter } from './crmFields'
import { MessageComposer, VariableTextInput } from './composer/MessageComposer'
import type { MessageBlock } from './nodeRegistry'
import styles from './AutomationEditor.module.css'

type ConfigValue = Record<string, unknown>

interface NodeConfigBubbleProps {
  definition: NodeDefinition
  config: ConfigValue
  /** Posición sugerida (lado derecho del evento) en px del canvas */
  anchor: { x: number; y: number }
  bounds: { width: number; height: number }
  onChange: (config: ConfigValue) => void
  onRefreshWebhookSample?: (endpointId: string) => Promise<Record<string, unknown> | null>
  onClose: () => void
}

const PANEL_WIDTH = 440

const str = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)

const hasSampleResponse = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0)
}

export const NodeConfigBubble: React.FC<NodeConfigBubbleProps> = ({
  definition,
  config,
  anchor,
  bounds,
  onChange,
  onRefreshWebhookSample,
  onClose
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [checkingSample, setCheckingSample] = useState(false)

  const customTitle = str(config.customTitle).trim()

  const startTitleEdit = () => {
    setDraftTitle(customTitle)
    setEditingTitle(true)
    window.setTimeout(() => titleInputRef.current?.focus(), 0)
  }

  const commitTitle = () => {
    setEditingTitle(false)
    onChange({ ...config, customTitle: draftTitle.trim().slice(0, 80) })
  }

  const requestClose = () => {
    onClose()
  }

  const setValue = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value })
  }

  // Genera la URL del webhook entrante la primera vez que se abre
  const needsEndpoint =
    definition.fields.some((field) => field.type === 'webhookUrl') && !str(config.endpointId)
  useEffect(() => {
    if (needsEndpoint) {
      setValue('endpointId', genId('hook'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsEndpoint])

  useEffect(() => {
    const endpointId = str(config.endpointId)
    if (!onRefreshWebhookSample || !endpointId || config.sampleStatus !== 'waiting' || hasSampleResponse(config.sampleResponse)) {
      return
    }

    let cancelled = false
    const refresh = async () => {
      setCheckingSample(true)
      try {
        await onRefreshWebhookSample(endpointId)
      } catch {
        // El botón manual permite intentar de nuevo; no ensuciamos el panel con errores transitorios.
      } finally {
        if (!cancelled) setCheckingSample(false)
      }
    }

    void refresh()
    const interval = window.setInterval(refresh, 2500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [config.endpointId, config.sampleResponse, config.sampleStatus, onRefreshWebhookSample])

  const insertVariable = (key: string, variable: string) => {
    const current = str(config[key])
    setValue(key, current ? `${current} ${variable}` : variable)
  }

  // ------------------------------------------------------------------
  // Render genérico de un campo declarativo
  // ------------------------------------------------------------------
  const renderField = (field: ConfigField) => {
    if (field.showIf && !field.showIf(config)) return null

    switch (field.type) {
      case 'text':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {field.showVariables ? (
              <VariableTextInput
                value={str(config[field.key])}
                onChange={(compiled) => setValue(field.key, compiled)}
                placeholder={field.placeholder}
                aria-label={field.label}
              />
            ) : (
              <TextInput
                value={str(config[field.key])}
                placeholder={field.placeholder}
                onChange={(event) => setValue(field.key, event.target.value)}
              />
            )}
          </Field>
        )

      case 'textarea':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {field.showVariables ? (
              <MessageComposer
                value={str(config[field.key])}
                onChange={(compiled) => setValue(field.key, compiled)}
                placeholder={field.placeholder}
                showEmoji={Boolean(definition.supportsEmoji)}
                aria-label={field.label}
              />
            ) : (
              <TextArea
                value={str(config[field.key])}
                placeholder={field.placeholder}
                onChange={(event) => setValue(field.key, event.target.value)}
              />
            )}
          </Field>
        )

      case 'number':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <TextInput
              type="number"
              value={config[field.key] === undefined || config[field.key] === '' ? '' : Number(config[field.key])}
              placeholder={field.placeholder}
              onChange={(event) =>
                setValue(field.key, event.target.value === '' ? '' : Number(event.target.value))
              }
            />
          </Field>
        )

      case 'select':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <CustomSelect
              options={field.options || []}
              value={str(config[field.key])}
              onValueChange={(value) => setValue(field.key, value)}
              placeholder="Selecciona una opción"
              aria-label={field.label}
            />
          </Field>
        )

      case 'catalogSelect':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <CatalogSelect
              catalog={field.catalog || 'tags'}
              value={str(config[field.key])}
              onChange={(value, label) =>
                onChange({ ...config, [field.key]: value, [`${field.key}Name`]: label })
              }
              placeholder={field.placeholder || 'Selecciona una opción'}
              aria-label={field.label}
            />
          </Field>
        )

      case 'catalogTags':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <CatalogTags
              catalog={field.catalog || 'tags'}
              values={Array.isArray(config[field.key]) ? (config[field.key] as string[]) : []}
              onChange={(values) => setValue(field.key, values)}
              aria-label={field.label}
            />
          </Field>
        )

      case 'toggle':
        return (
          <Toggle
            key={field.key}
            checked={Boolean(config[field.key])}
            onChange={(checked) => setValue(field.key, checked)}
            label={field.label}
          />
        )

      case 'datetime':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <TextInput
              type="datetime-local"
              value={str(config[field.key])}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          </Field>
        )

      case 'time':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <TextInput
              type="time"
              value={str(config[field.key])}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          </Field>
        )

      case 'weekdays':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <WeekdaysPicker
              values={Array.isArray(config[field.key]) ? (config[field.key] as string[]) : []}
              onChange={(values) => setValue(field.key, values)}
            />
          </Field>
        )

      case 'duration':
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            <DurationInput
              amount={Number(config.amount) || 0}
              unit={str(config.unit) || 'hours'}
              onChange={(amount, unit) => onChange({ ...config, amount, unit })}
            />
          </Field>
        )

      case 'keywords': {
        const keywords = Array.isArray(config[field.key]) ? (config[field.key] as string[]) : []
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {keywords.length > 0 && (
              <div className={styles.keywordChips}>
                {keywords.map((keyword) => (
                  <span key={keyword} className={styles.keywordChip}>
                    {keyword}
                    <button
                      type="button"
                      className={styles.keywordChipRemove}
                      title="Quitar palabra"
                      onClick={() => setValue(field.key, keywords.filter((value) => value !== keyword))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <TextInput
              placeholder={field.placeholder || 'Escribe y presiona Enter'}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                const target = event.target as HTMLInputElement
                const value = target.value.trim()
                if (value && !keywords.includes(value)) {
                  setValue(field.key, [...keywords, value])
                }
                target.value = ''
              }}
            />
          </Field>
        )
      }

      case 'keyValue': {
        const rows = Array.isArray(config[field.key])
          ? (config[field.key] as Array<{ key?: string; value?: string }>)
          : []
        const updateRow = (index: number, patch: { key?: string; value?: string }) => {
          setValue(field.key, rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
        }
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {rows.map((row, index) => (
              <div key={index} className={styles.configRow} style={{ marginBottom: 6 }}>
                <TextInput
                  className={styles.configRowGrow}
                  placeholder="Clave"
                  value={str(row.key)}
                  onChange={(event) => updateRow(index, { key: event.target.value })}
                />
                <TextInput
                  className={styles.configRowGrow}
                  placeholder="Valor"
                  value={str(row.value)}
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className={styles.configIconButton}
                  title="Quitar"
                  onClick={() => setValue(field.key, rows.filter((_, rowIndex) => rowIndex !== index))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles.configSmallButton}
              onClick={() => setValue(field.key, [...rows, { key: '', value: '' }])}
            >
              <Plus size={11} />
              Agregar
            </button>
          </Field>
        )
      }

      case 'customFieldValues': {
        const rows = Array.isArray(config[field.key])
          ? (config[field.key] as Array<{ key?: string; keyName?: string; value?: string }>)
          : []
        const updateRow = (index: number, patch: { key?: string; keyName?: string; value?: string }) => {
          setValue(field.key, rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
        }
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {rows.map((row, index) => (
              <div key={index} className={styles.configRow} style={{ marginBottom: 6 }}>
                <div className={styles.configRowGrow}>
                  <CatalogSelect
                    catalog="customFields"
                    value={str(row.key)}
                    onChange={(value, label) => updateRow(index, { key: value, keyName: label })}
                    placeholder="Campo personalizado"
                    aria-label="Campo personalizado"
                  />
                </div>
                <TextInput
                  className={styles.configRowGrow}
                  placeholder="Valor"
                  value={str(row.value)}
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                />
                <button
                  type="button"
                  className={styles.configIconButton}
                  title="Quitar"
                  onClick={() => setValue(field.key, rows.filter((_, rowIndex) => rowIndex !== index))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className={styles.configSmallButton}
              onClick={() => setValue(field.key, [...rows, { key: '', value: '' }])}
            >
              <Plus size={11} />
              Agregar campo
            </button>
          </Field>
        )
      }

      case 'percentBranches':
      case 'branches': {
        const withPercent = field.type === 'percentBranches'
        const rows = Array.isArray(config[field.key])
          ? (config[field.key] as Array<{ id?: string; label?: string; percent?: number }>)
          : []
        const total = rows.reduce((sum, row) => sum + (Number(row.percent) || 0), 0)
        const updateRow = (index: number, patch: Record<string, unknown>) => {
          setValue(field.key, rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
        }
        return (
          <Field key={field.key} label={field.label} help={field.help}>
            {rows.map((row, index) => (
              <div key={row.id || index} className={styles.configRow} style={{ marginBottom: 6 }}>
                <TextInput
                  className={styles.configRowGrow}
                  placeholder={`Rama ${index + 1}`}
                  value={str(row.label)}
                  onChange={(event) => updateRow(index, { label: event.target.value })}
                />
                {withPercent && (
                  <TextInput
                    style={{ width: 72 }}
                    type="number"
                    min={0}
                    max={100}
                    value={Number(row.percent) || 0}
                    onChange={(event) => updateRow(index, { percent: Number(event.target.value) })}
                  />
                )}
                <button
                  type="button"
                  className={styles.configIconButton}
                  title="Quitar rama"
                  disabled={rows.length <= 2}
                  style={rows.length <= 2 ? { opacity: 0.35, cursor: 'default' } : undefined}
                  onClick={() => {
                    if (rows.length <= 2) return
                    setValue(field.key, rows.filter((_, rowIndex) => rowIndex !== index))
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className={styles.configRow} style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className={styles.configSmallButton}
                onClick={() =>
                  setValue(field.key, [
                    ...rows,
                    withPercent
                      ? { id: genId('branch'), label: String.fromCharCode(65 + rows.length), percent: 0 }
                      : { id: genId('branch'), label: `Rama ${rows.length + 1}` }
                  ])
                }
              >
                <Plus size={11} />
                Agregar rama
              </button>
              {withPercent && (
                <span className={cn(styles.percentTotal, total !== 100 && styles.percentTotalError)}>
                  Total: {total}%
                </span>
              )}
            </div>
          </Field>
        )
      }

      case 'webhookUrl': {
        const endpointId = str(config.endpointId)
        const url = endpointId
          ? `${window.location.origin}/webhook/automations/${endpointId}`
          : 'Generando URL…'
        const hasSample = hasSampleResponse(config.sampleResponse)
        const waiting = config.sampleStatus === 'waiting' && !hasSample
        const sampleStatus = hasSample
          ? 'Datos recibidos correctamente'
          : waiting
            ? 'Esperando datos de prueba'
            : 'Sin datos de prueba'
        return (
          <Field
            key={field.key}
            label={field.label}
            help="Envía una llamada HTTP a esta URL para iniciar la automatización."
          >
            <div className={styles.webhookUrlBox}>
              <span className={styles.webhookUrlText} title={url}>
                {url}
              </span>
              <button
                type="button"
                className={styles.configIconButton}
                style={{ color: copied ? 'var(--color-status-success)' : undefined }}
                title="Copiar URL"
                onClick={() => {
                  void navigator.clipboard?.writeText(url).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1600)
                  })
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </div>
            <div
              className={cn(
                styles.webhookTestPanel,
                hasSample && styles.webhookTestPanelSuccess,
                waiting && styles.webhookTestPanelWaiting
              )}
            >
              <div className={styles.webhookTestHeader}>
                <span className={styles.webhookTestStatus}>{sampleStatus}</span>
                <span className={styles.webhookTestHint}>
                  {hasSample
                    ? str(config.sampleReceivedAt) || 'Muestra guardada'
                    : 'Sin muestra no se pueden insertar variables de este webhook'}
                </span>
              </div>
              <div className={styles.configRow}>
                <button
                  type="button"
                  className={styles.configSmallButton}
                  onClick={() =>
                    onChange({
                      ...config,
                      sampleResponse: null,
                      sampleStatus: 'waiting',
                      sampleRequestedAt: new Date().toISOString()
                    })
                  }
                >
                  <RefreshCw size={11} />
                  Probar webhook
                </button>
                {onRefreshWebhookSample && (
                  <button
                    type="button"
                    className={styles.configIconButton}
                    title="Actualizar estado"
                    disabled={checkingSample || !endpointId}
                    onClick={() => {
                      setCheckingSample(true)
                      void onRefreshWebhookSample(endpointId).finally(() => setCheckingSample(false))
                    }}
                  >
                    {checkingSample ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  </button>
                )}
              </div>
              {hasSample && (
                <pre className={styles.webhookSamplePreview}>
                  {JSON.stringify(config.sampleResponse, null, 2)}
                </pre>
              )}
            </div>
          </Field>
        )
      }

      case 'info':
        return (
          <Field key={field.key} label={field.label}>
            <pre className={styles.configInfo}>{field.text}</pre>
          </Field>
        )

      default:
        return null
    }
  }

  // El panel aparece a la derecha del evento y A SU ALTURA: si el contenido
  // es alto y no cabe, se desplaza hacia arriba solo lo necesario.
  const left = Math.max(12, Math.min(anchor.x, bounds.width - PANEL_WIDTH - 12))
  const [top, setTop] = useState(() => Math.max(12, anchor.y))

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const reposition = () => {
      const height = element.offsetHeight
      setTop(Math.max(12, Math.min(anchor.y, bounds.height - height - 12)))
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(element)
    return () => observer.disconnect()
  }, [anchor.y, bounds.height])

  return (
    <div
      ref={rootRef}
      data-automation-interactive="true"
      className={styles.configPanel}
      style={{ left, top }}
      role="complementary"
      aria-label={`Configurar ${definition.label}`}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          requestClose()
        }
      }}
    >
      <div className={styles.bubbleHeader}>
        <span className={styles.pickerItemIcon} data-accent={definition.accent}>
          <definition.icon size={14} />
        </span>
        <div className={styles.bubbleTitle}>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              data-ristak-unstyled
              className={styles.panelTitleInput}
              value={draftTitle}
              maxLength={80}
              placeholder={definition.label}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') commitTitle()
                if (event.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <button
              type="button"
              className={styles.panelTitleButton}
              title="Cambiar el título de esta acción"
              onClick={startTitleEdit}
            >
              {customTitle || definition.label}
              <Pencil size={12} className={styles.panelTitlePencil} />
            </button>
          )}
          {definition.description && <div className={styles.bubbleSubtitle}>{definition.description}</div>}
        </div>
        <button type="button" className={styles.bubbleClose} onClick={requestClose} title="Cerrar (Esc)">
          <X size={14} />
        </button>
      </div>

      <div className={styles.bubbleBody}>
        {definition.configComponent === 'conditions' && (
          <AdvancedConditionBuilder
            value={config}
            onChange={(next) => onChange({ ...config, ...next })}
            allowBranches
          />
        )}
        {definition.configComponent === 'wait' && <WaitConfigEditor config={config} onChange={onChange} />}
        {definition.configComponent === 'goal' && <GoalConfigEditor config={config} onChange={onChange} />}
        {definition.configComponent === 'whatsapp' && (
          <WhatsAppConfigEditor config={config} onChange={onChange} />
        )}
        {definition.configComponent === 'message' && (
          <>
            {definition.fields.map(renderField)}
            <MessageBlocksEditor
              value={config.messageBlocks}
              onChange={(messageBlocks: MessageBlock[]) => onChange({ ...config, messageBlocks })}
              supportsQuickReplies={Boolean(definition.supportsQuickReplies)}
            />
          </>
        )}

        {!definition.configComponent && definition.fields.length === 0 && definition.kind !== 'trigger' && (
          <p className={styles.configHelp}>Este paso no necesita configuración.</p>
        )}
        {/* Solo los campos indispensables a la vista */}
        {!definition.configComponent && definition.fields.filter((field) => !field.advanced).map(renderField)}

        {/* Filtros avanzados del disparador (coincide / NO coincide) */}
        {definition.kind === 'trigger' && (
          <TriggerFiltersEditor
            value={config.filters}
            onChange={(filters: TriggerFilter[]) => setValue('filters', filters)}
            contextKey={definition.type}
          />
        )}

        {/* Lo demás vive detrás de "Opciones avanzadas" (los disparadores
            no la usan: ahí todo extra se agrega con "+ Añadir filtro") */}
        {!definition.configComponent && definition.kind !== 'trigger' && definition.fields.some((field) => field.advanced) && (
          <>
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              <ChevronRight
                size={12}
                className={cn(styles.varCategoryChevron, showAdvanced && styles.varCategoryChevronOpen)}
              />
              Opciones avanzadas
            </button>
            {showAdvanced && definition.fields.filter((field) => field.advanced).map(renderField)}
          </>
        )}



        {/* Ramas extra del nodo (hasta 10 salidas) */}
        {definition.supportsMultipleBranches && (
          <Field label="Ramas del paso" help="Cada rama es una salida propia que puedes conectar a pasos distintos">
            {(Array.isArray(config.extraBranches) ? (config.extraBranches as Array<{ id: string; label: string }>) : []).map(
              (branch, index) => (
                <div key={branch.id || index} className={styles.configRow} style={{ marginBottom: 6 }}>
                  <TextInput
                    className={styles.configRowGrow}
                    value={branch.label || ''}
                    maxLength={40}
                    placeholder={`Rama ${index + 1}`}
                    onChange={(event) => {
                      const branches = (config.extraBranches as Array<{ id: string; label: string }>).map(
                        (candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, label: event.target.value } : candidate
                      )
                      setValue('extraBranches', branches)
                    }}
                  />
                  <button
                    type="button"
                    className={styles.configIconButton}
                    title="Quitar rama (también elimina su conexión)"
                    onClick={() => {
                      const branches = (config.extraBranches as Array<{ id: string; label: string }>).filter(
                        (_, candidateIndex) => candidateIndex !== index
                      )
                      setValue('extraBranches', branches)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            )}
            <button
              type="button"
              className={styles.configSmallButton}
              disabled={validateNodeConfig(definition, config).some((error) => error.includes('Máximo'))}
              onClick={() => {
                const branches = Array.isArray(config.extraBranches)
                  ? (config.extraBranches as Array<{ id: string; label: string }>)
                  : []
                setValue('extraBranches', [
                  ...branches,
                  { id: genId('extra'), label: `Rama ${branches.length + 1}` }
                ])
              }}
            >
              <Plus size={11} />
              Agregar rama
            </button>
          </Field>
        )}
      </div>
    </div>
  )
}
