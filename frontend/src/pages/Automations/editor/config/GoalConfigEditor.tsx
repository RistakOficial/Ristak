import React, { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/utils/cn'
import { CustomSelect } from './configPrimitives'
import { TriggerFiltersEditor } from './TriggerFiltersEditor'
import type { TriggerFilter } from '../crmFields'
import styles from '../AutomationEditor.module.css'
import { CHANNEL_OPTIONS_WITH_ANY } from '../nodeRegistry'
import { CatalogSelect, ConfigSection, DurationInput, Field, TextInput } from './configPrimitives'
import { AdvancedConditionBuilder } from './AdvancedConditionBuilder'
import type { AdvancedConditionConfig } from '../crmFields'

/**
 * Configurador del nodo "Evento objetivo": una meta real (etiqueta, pago,
 * cita, formulario, link, conversación, contacto, ads o evento personalizado)
 * que puede terminar la automatización, sacar al contacto o continuar el
 * flujo cuando se cumple.
 */

type Config = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const GOAL_TYPES = [
  { value: 'tag', label: 'Etiqueta' },
  { value: 'payment', label: 'Pago' },
  { value: 'appointment', label: 'Cita / agenda' },
  { value: 'form', label: 'Formulario' },
  { value: 'link', label: 'Clics de disparo' },
  { value: 'conversation', label: 'Conversación' },
  { value: 'contact', label: 'Contacto / CRM' },
  { value: 'ads', label: 'Ads / campañas' },
  { value: 'custom', label: 'Evento personalizado' },
  { value: 'advanced', label: 'Condición avanzada por grupos' }
]

export const GoalConfigEditor: React.FC<{ config: Config; onChange: (config: Config) => void }> = ({
  config,
  onChange
}) => {
  const set = (patch: Config) => onChange({ ...config, ...patch })
  const goalType = str(config.goalType)
  const [showAdvanced, setShowAdvanced] = useState(false)

  return (
    <div>
      <Field label="Tipo de objetivo">
        <CustomSelect
          options={GOAL_TYPES}
          value={goalType}
          onValueChange={(next) => set({ goalType: next })}
          placeholder="Selecciona el tipo de objetivo"
          aria-label="Tipo de objetivo"
        />
      </Field>

      {/* --------------------------- por tipo --------------------------- */}

      {goalType === 'tag' && (
        <>
          <Field label="El objetivo se cumple cuando">
            <CustomSelect
              options={[
                { value: 'has', label: 'El contacto tiene la etiqueta' },
                { value: 'received', label: 'El contacto recibe la etiqueta' },
                { value: 'lost', label: 'El contacto pierde la etiqueta' },
                { value: 'not_has', label: 'El contacto no contiene la etiqueta' }
              ]}
              value={str(config.tagOperator) || 'has'}
              onValueChange={(next) => set({ tagOperator: next })}
              aria-label="Condición de etiqueta"
            />
          </Field>
          <Field label="Etiqueta">
            <CatalogSelect
              catalog="tags"
              value={str(config.tag)}
              onChange={(value, label) => set({ tag: value, tagName: label })}
              placeholder="Selecciona la etiqueta"
              aria-label="Etiqueta"
            />
          </Field>
        </>
      )}

      {goalType === 'payment' && (
        <>
          <Field label="Evento de pago">
            <CustomSelect
              options={[
                { value: 'received', label: 'Pago recibido' },
                { value: 'failed', label: 'Pago fallido' },
                { value: 'refund', label: 'Refund / reembolso' }
              ]}
              value={str(config.paymentEvent) || 'received'}
              onValueChange={(next) => set({ paymentEvent: next })}
              aria-label="Evento de pago"
            />
          </Field>
          <Field label="Monto">
            <CustomSelect
              options={[
                { value: 'any', label: 'Cualquier monto' },
                { value: 'gt', label: 'Mayor que' },
                { value: 'lt', label: 'Menor que' },
                { value: 'eq', label: 'Igual a' }
              ]}
              value={str(config.amountOperator) || 'any'}
              onValueChange={(next) => set({ amountOperator: next })}
              aria-label="Comparación de monto"
            />
          </Field>
          {str(config.amountOperator) !== 'any' && str(config.amountOperator) !== '' && (
            <Field label="Cantidad">
              <TextInput
                type="number"
                min={0}
                value={config.amount === undefined ? '' : String(config.amount)}
                onChange={(event) => set({ amount: event.target.value })}
              />
            </Field>
          )}
        </>
      )}

      {goalType === 'appointment' && (
        <>
          <Field label="Estado de la cita">
            <CustomSelect
              options={[
                { value: 'booked', label: 'Cita agendada' },
                { value: 'confirmed', label: 'Cita confirmada' },
                { value: 'cancelled', label: 'Cita cancelada' },
                { value: 'rescheduled', label: 'Cita reprogramada' },
                { value: 'no_show', label: 'Cita no asistida' },
                { value: 'completed', label: 'Cita completada' }
              ]}
              value={str(config.appointmentStatus) || 'booked'}
              onValueChange={(next) => set({ appointmentStatus: next })}
              aria-label="Estado de la cita"
            />
          </Field>
        </>
      )}

      {goalType === 'form' && (
        <>
          <Field label="Formulario">
            <CatalogSelect
              catalog="forms"
              value={str(config.form)}
              onChange={(value, label) => set({ form: value, formName: label })}
              placeholder="Selecciona el formulario"
              aria-label="Formulario"
            />
          </Field>
        </>
      )}

      {goalType === 'link' && (
        <>
          <Field label="Evento">
            <CustomSelect
              options={[
                { value: 'clicked', label: 'Clic de disparo recibido' },
                { value: 'activation', label: 'Clic de disparo de activación' }
              ]}
              value={str(config.linkEvent) || 'clicked'}
              onValueChange={(next) => set({ linkEvent: next })}
              aria-label="Evento de clic de disparo"
            />
          </Field>
          <Field label="Clic de disparo específico (opcional)">
            <CatalogSelect
              catalog="links"
              value={str(config.link)}
              onChange={(value, label) => set({ link: value, linkName: label })}
              placeholder="Cualquier clic de disparo"
              aria-label="Clic de disparo"
            />
          </Field>
        </>
      )}

      {goalType === 'conversation' && (
        <>
          <Field label="El objetivo se cumple cuando">
            <CustomSelect
              options={[
                { value: 'replied', label: 'El contacto responde' },
                { value: 'keyword', label: 'La respuesta contiene palabra clave' },
                { value: 'no_reply', label: 'No ha respondido después de cierto tiempo' }
              ]}
              value={str(config.conversationEvent) || 'replied'}
              onValueChange={(next) => set({ conversationEvent: next })}
              aria-label="Evento de conversación"
            />
          </Field>
          <Field label="Canal">
            <CustomSelect
              options={CHANNEL_OPTIONS_WITH_ANY}
              value={str(config.conversationChannel) || 'any'}
              onValueChange={(next) => set({ conversationChannel: next })}
              aria-label="Canal"
            />
          </Field>
          {str(config.conversationEvent) === 'keyword' && (
            <Field label="Palabra clave">
              <TextInput
                value={str(config.keyword)}
                placeholder="Ej. confirmo"
                onChange={(event) => set({ keyword: event.target.value })}
              />
            </Field>
          )}
        </>
      )}

      {goalType === 'contact' && (
        <>
          <Field label="Evento del contacto">
            <CustomSelect
              options={[
                { value: 'created', label: 'Contacto creado' },
                { value: 'updated', label: 'Contacto modificado' },
                { value: 'field_contains', label: 'Campo contiene valor' },
                { value: 'assigned', label: 'Usuario asignado' }
              ]}
              value={str(config.contactEvent) || 'created'}
              onValueChange={(next) => set({ contactEvent: next })}
              aria-label="Evento del contacto"
            />
          </Field>
          {(str(config.contactEvent) === 'updated' || str(config.contactEvent) === 'field_contains') && (
            <Field label="Campo">
              <CatalogSelect
                catalog="contactFields"
                value={str(config.contactField)}
                onChange={(value, label) => set({ contactField: value, contactFieldName: label })}
                placeholder="Selecciona el campo"
                aria-label="Campo"
              />
            </Field>
          )}
          {str(config.contactEvent) === 'field_contains' && (
            <Field label="Debe contener">
              <TextInput
                value={str(config.contactFieldValue)}
                onChange={(event) => set({ contactFieldValue: event.target.value })}
              />
            </Field>
          )}
        </>
      )}

      {goalType === 'ads' && (
        <>
          <Field label="Evento de anuncio">
            <CustomSelect
              options={[
                { value: 'fb_click', label: 'Clic en anuncio de Facebook' },
                { value: 'ctwa', label: 'Click to WhatsApp ads' }
              ]}
              value={str(config.adsEvent) || 'fb_click'}
              onValueChange={(next) => set({ adsEvent: next })}
              aria-label="Evento de anuncio"
            />
          </Field>
        </>
      )}

      {goalType === 'custom' && (
        <>
          <Field label="Nombre del evento">
            <TextInput
              value={str(config.customEventName)}
              placeholder="Ej. webhook_compra"
              onChange={(event) => set({ customEventName: event.target.value })}
            />
          </Field>
          <Field label="El payload debe contener (opcional)">
            <TextInput
              value={str(config.payloadContains)}
              placeholder='Ej. "status": "ok"'
              onChange={(event) => set({ payloadContains: event.target.value })}
            />
          </Field>
        </>
      )}

      {goalType === 'advanced' && (
        <ConfigSection title="El objetivo se cumple cuando el contacto cumple">
          <AdvancedConditionBuilder
            value={config.advancedCondition}
            onChange={(advancedCondition: AdvancedConditionConfig) => set({ advancedCondition })}
          />
        </ConfigSection>
      )}

      {/* Lo específico se agrega con filtros congruentes al tipo elegido */}
      {goalType && goalType !== 'advanced' && (
        <TriggerFiltersEditor
          value={config.filters}
          onChange={(filters: TriggerFilter[]) => set({ filters })}
          contextKey={`goal-${goalType}`}
        />
      )}

      {/* -------------------- evaluación y comportamiento -------------------- */}

      {goalType && (
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
        </>
      )}

      {goalType && showAdvanced && (
        <>
          <ConfigSection title="Cuándo evaluar el objetivo">
            <CustomSelect
              options={[
                { value: 'immediate', label: 'Inmediatamente cuando el contacto pasa por este paso' },
                { value: 'during-automation', label: 'Durante toda la automatización' },
                { value: 'window', label: 'Durante un tiempo máximo' }
              ]}
              value={str(config.evaluate) || 'during-automation'}
              onValueChange={(next) => set({ evaluate: next })}
              aria-label="Cuándo evaluar"
            />
          </ConfigSection>

          <ConfigSection title="Al cumplirse el objetivo">
            <CustomSelect
              options={[
                { value: 'end-automation', label: 'Terminar la automatización para el contacto' },
                { value: 'end-branch', label: 'Terminar solo esta rama' },
                { value: 'continue', label: 'Marcar como cumplido y continuar' },
                { value: 'remove', label: 'Remover al contacto de esta automatización' }
              ]}
              value={str(config.onMet) || 'end-automation'}
              onValueChange={(next) => set({ onMet: next })}
              aria-label="Al cumplirse"
            />
          </ConfigSection>

          <ConfigSection title="Si no se cumple">
            <CustomSelect
              options={[
                { value: 'continue', label: 'Continuar normalmente' },
                { value: 'wait', label: 'Esperar hasta que se cumpla' },
                { value: 'timeout-branch', label: 'Continuar por la salida "No cumplido" al agotar el tiempo' }
              ]}
              value={str(config.onNotMet) || 'continue'}
              onValueChange={(next) => set({ onNotMet: next })}
              aria-label="Si no se cumple"
            />
          </ConfigSection>

          <ConfigSection title="Ventana de tiempo">
            <CustomSelect
              options={[
                { value: 'none', label: 'Sin límite' },
                { value: 'duration', label: 'Durante un tiempo' },
                { value: 'until', label: 'Hasta una fecha específica' }
              ]}
              value={str(config.windowMode) || 'none'}
              onValueChange={(next) => set({ windowMode: next })}
              aria-label="Ventana de tiempo"
            />
            {str(config.windowMode) === 'duration' && (
              <div style={{ marginTop: 8 }}>
                <DurationInput
                  amount={Number(config.windowAmount) || 0}
                  unit={str(config.windowUnit) || 'days'}
                  onChange={(windowAmount, windowUnit) => set({ windowAmount, windowUnit })}
                />
              </div>
            )}
            {str(config.windowMode) === 'until' && (
              <div style={{ marginTop: 8 }}>
                <TextInput
                  type="datetime-local"
                  value={str(config.windowUntil)}
                  onChange={(event) => set({ windowUntil: event.target.value })}
                />
              </div>
            )}
          </ConfigSection>
        </>
      )}
    </div>
  )
}
