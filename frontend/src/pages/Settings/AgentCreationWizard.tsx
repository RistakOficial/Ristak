import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Sparkles, Calendar, ShoppingBag, ClipboardList, Filter, Wand2,
  Building2, User, Coffee, Compass, Target, Briefcase, Smile, MessageCircle,
  UserCheck, CalendarCheck, CreditCard, Link2, Rocket, type LucideIcon
} from 'lucide-react'
import { Modal, Button } from '@/components/common'
import type {
  AgentIdentityMode, ConversationalLanguageLevel, ConversationalObjective,
  ConversationalPersuasionLevel, ConversationalSuccessAction
} from '@/services/conversationalAgentService'
import { StepArt } from './AgentCreationWizardArt'
import styles from './AgentCreationWizard.module.css'

export interface AgentWizardDraft {
  name: string
  objective: ConversationalObjective
  customObjective: string
  identityMode: AgentIdentityMode
  identityCustomName: string
  successAction: ConversationalSuccessAction
  requiredData: string
  persuasionLevel: ConversationalPersuasionLevel
  languageLevel: ConversationalLanguageLevel
}

interface Choice<T extends string> {
  value: T
  label: string
  example: string
  Icon: LucideIcon
}

// Lenguaje muy sencillo, coloquial, con ejemplos y comparaciones: el wizard también enseña.
const objectiveChoices: Array<Choice<ConversationalObjective>> = [
  { value: 'citas', label: 'Agendar citas', example: 'Lleva a la persona hasta que aparta día y hora. Como una recepcionista que llena la agenda.', Icon: Calendar },
  { value: 'ventas', label: 'Cerrar ventas', example: 'Lleva a la persona hasta que quiere pagar. Como un buen vendedor de piso.', Icon: ShoppingBag },
  { value: 'datos', label: 'Juntar datos', example: 'Pide lo que falta (nombre, correo, teléfono). Como llenar una ficha sin que se sienta interrogatorio.', Icon: ClipboardList },
  { value: 'filtrar', label: 'Filtrar curiosos', example: 'Separa al que va en serio del que solo pregunta por ver. Como un cadenero amable.', Icon: Filter },
  { value: 'custom', label: 'Mi propia meta', example: 'Tú la escribes. Ejemplo: "que pida una cotización formal".', Icon: Wand2 }
]

const identityChoices: Array<Choice<AgentIdentityMode>> = [
  { value: 'business', label: 'Como el negocio', example: 'Habla en plural: "nosotros te ayudamos". Suena a equipo, no a una persona.', Icon: Building2 },
  { value: 'custom', label: 'Con un nombre propio', example: 'Se presenta con nombre: "hola, soy Sofía". Se siente más humano y cercano.', Icon: User }
]

const persuasionChoices: Array<Choice<ConversationalPersuasionLevel>> = [
  { value: 'low', label: 'Anfitrión', example: 'Atiende, resuelve y da precios. No empuja: cierra solo si se lo piden. Como un mesero que no te apura.', Icon: Coffee },
  { value: 'medium', label: 'Estratega', example: 'Te entiende y te guía con tacto al siguiente paso, sin presionar. El punto medio.', Icon: Compass },
  { value: 'high', label: 'Cerrador', example: 'Va con todo a cerrar, con criterio y sin sonar desesperado. Como tu mejor vendedor.', Icon: Target }
]

const languageChoices: Array<Choice<ConversationalLanguageLevel>> = [
  { value: 'professional', label: 'Ejecutivo', example: 'Pulido y formal, pero humano. Para marcas premium. Como hablarle a un cliente importante.', Icon: Briefcase },
  { value: 'intermediate', label: 'Cómplice', example: 'Natural y cercano, ni tieso ni vulgar. El punto dulce que le queda a casi todos.', Icon: Smile },
  { value: 'colloquial', label: 'Callejero', example: 'Bien suelto y de la región, como mensaje entre cuates. Lo más relajado.', Icon: MessageCircle }
]

const actionChoicesByObjective: Record<ConversationalObjective, Array<Choice<ConversationalSuccessAction>>> = {
  citas: [
    { value: 'ready_for_human', label: 'Avisar al equipo', example: 'Cuando ya quiere cita, detiene el bot y le avisa a tu gente para agendar.', Icon: UserCheck },
    { value: 'book_appointment', label: 'Que la IA agende', example: 'La IA confirma un horario real y aparta la cita en el calendario, solita.', Icon: CalendarCheck },
    { value: 'send_goal_url', label: 'Mandar enlace', example: 'Manda el link del calendario para que la persona elija su horario.', Icon: Link2 }
  ],
  ventas: [
    { value: 'ready_for_human', label: 'Avisar al equipo', example: 'Cuando ya quiere comprar, detiene el bot y avisa a tu gente para cerrar.', Icon: UserCheck },
    { value: 'ready_to_buy', label: 'Que la IA cobre', example: 'La IA guía el pago y la venta se cierra cuando el dinero entra.', Icon: CreditCard },
    { value: 'send_goal_url', label: 'Mandar enlace', example: 'Manda el link de compra para que la persona pague.', Icon: Link2 }
  ],
  datos: [
    { value: 'ready_for_human', label: 'Avisar al equipo', example: 'Junta los datos y avisa a tu gente para que continúe.', Icon: UserCheck }
  ],
  filtrar: [
    { value: 'ready_for_human', label: 'Avisar al equipo', example: 'Filtra la plática y avisa cuando el prospecto ya vale la pena atender.', Icon: UserCheck }
  ],
  custom: [
    { value: 'ready_for_human', label: 'Avisar al equipo', example: 'Cuando la meta está lista, detiene el bot y avisa a tu gente.', Icon: UserCheck },
    { value: 'send_trigger_link', label: 'Mandar enlace', example: 'Manda un enlace y se detiene cuando la persona lo abre.', Icon: Link2 }
  ]
}

type StepId = 'welcome' | 'name' | 'objective' | 'identity' | 'persuasion' | 'language' | 'action' | 'data' | 'recap'
const STEPS: StepId[] = ['welcome', 'name', 'objective', 'identity', 'persuasion', 'language', 'action', 'data', 'recap']
const TOTAL_QUESTIONS = 7

function buildInitialDraft(defaultName: string): AgentWizardDraft {
  return {
    name: defaultName,
    objective: 'citas',
    customObjective: '',
    identityMode: 'business',
    identityCustomName: '',
    successAction: 'ready_for_human',
    requiredData: '',
    persuasionLevel: 'high',
    languageLevel: 'intermediate'
  }
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onComplete: (draft: AgentWizardDraft) => void | Promise<void>
  onSkipToManual?: () => void
  creating?: boolean
  defaultName?: string
}

export function AgentCreationWizard({ isOpen, onClose, onComplete, onSkipToManual, creating = false, defaultName = '' }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<AgentWizardDraft>(() => buildInitialDraft(defaultName))

  // Reinicia el wizard cada vez que se abre.
  useEffect(() => {
    if (isOpen) {
      setStepIndex(0)
      setDraft(buildInitialDraft(defaultName))
    }
  }, [isOpen, defaultName])

  const step = STEPS[stepIndex]
  const questionNumber = stepIndex >= 1 && stepIndex <= TOTAL_QUESTIONS ? stepIndex : null
  const actionChoices = actionChoicesByObjective[draft.objective] || actionChoicesByObjective.citas

  const patch = (next: Partial<AgentWizardDraft>) => setDraft((current) => ({ ...current, ...next }))

  const chooseObjective = (objective: ConversationalObjective) => {
    const firstAction = (actionChoicesByObjective[objective] || actionChoicesByObjective.citas)[0]?.value || 'ready_for_human'
    patch({ objective, successAction: firstAction, ...(objective === 'custom' ? {} : { customObjective: '' }) })
  }

  const canAdvance = useMemo(() => {
    if (step === 'name') return draft.name.trim().length > 0
    if (step === 'objective' && draft.objective === 'custom') return draft.customObjective.trim().length > 0
    return true
  }, [step, draft])

  const goNext = () => setStepIndex((i) => Math.min(i + 1, STEPS.length - 1))
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0))
  const finish = () => { void onComplete(draft) }

  const labelOf = <T extends string>(choices: Array<Choice<T>>, value: T) => choices.find((c) => c.value === value)?.label || ''

  return (
    <Modal isOpen={isOpen} onClose={onClose} type="custom" size="lg" flushContent title="Nuevo asistente">
      <div className={styles.wizard}>
        {questionNumber !== null && (
          <div className={styles.progress}>
            <span className={styles.progressText}>Pregunta {questionNumber} de {TOTAL_QUESTIONS}</span>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${(questionNumber / TOTAL_QUESTIONS) * 100}%` }} />
            </div>
          </div>
        )}

        <div className={styles.body}>
          <div className={styles.art}><StepArt kind={step} /></div>

          {step === 'welcome' && (
            <>
              <h2 className={styles.title}>Vamos a crear tu asistente 🎉</h2>
              <p className={styles.help}>Te voy a hacer <strong>7 preguntas rapiditas</strong>, una por una, con ejemplos. No hay respuestas malas y todo lo puedes cambiar después. ¡Hasta un niño lo arma!</p>
              <div className={styles.welcomeList}>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Le pones nombre y le dices qué debe lograr.</div>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Eliges qué tan vendedor y cómo habla.</div>
                <div className={styles.welcomeItem}><Sparkles size={16} /> Listo: empieza a atender tus chats.</div>
              </div>
              {onSkipToManual && (
                <button type="button" className={styles.skipLink} onClick={onSkipToManual} disabled={creating}>
                  Prefiero crearlo en blanco y configurarlo a mano
                </button>
              )}
            </>
          )}

          {step === 'name' && (
            <>
              <h2 className={styles.title}>¿Cómo se va a llamar?</h2>
              <p className={styles.help}>Ponle un nombre para reconocerlo tú. Como ponerle nombre a un empleado nuevo.</p>
              <input
                className={styles.input}
                value={draft.name}
                autoFocus
                placeholder="Ejemplo: Sofía de Recepción"
                onChange={(e) => patch({ name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && canAdvance) goNext() }}
              />
              <p className={styles.fieldHint}>Ejemplos: "Asistente de Ventas", "Carlos del Taller", "Bot de Citas".</p>
            </>
          )}

          {step === 'objective' && (
            <>
              <h2 className={styles.title}>¿Qué quieres que logre?</h2>
              <p className={styles.help}>Es su misión principal. Como decirle a un empleado: "tú encárgate de esto".</p>
              <div className={styles.options}>
                {objectiveChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.objective === value} Icon={Icon} label={label} example={example} onClick={() => chooseObjective(value)} />
                ))}
              </div>
              {draft.objective === 'custom' && (
                <input
                  className={styles.input}
                  value={draft.customObjective}
                  placeholder='Escribe la meta. Ejemplo: "que pida una cotización"'
                  onChange={(e) => patch({ customObjective: e.target.value })}
                />
              )}
            </>
          )}

          {step === 'identity' && (
            <>
              <h2 className={styles.title}>¿Como quién habla con la gente?</h2>
              <p className={styles.help}>Define si se siente como "la empresa" o como una persona con nombre.</p>
              <div className={styles.options}>
                {identityChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.identityMode === value} Icon={Icon} label={label} example={example} onClick={() => patch({ identityMode: value })} />
                ))}
              </div>
              {draft.identityMode === 'custom' && (
                <input
                  className={styles.input}
                  value={draft.identityCustomName}
                  placeholder='¿Cómo se presenta? Ejemplo: "Sofía"'
                  onChange={(e) => patch({ identityCustomName: e.target.value })}
                />
              )}
            </>
          )}

          {step === 'persuasion' && (
            <>
              <h2 className={styles.title}>¿Qué tan vendedor lo quieres?</h2>
              <p className={styles.help}>Piensa en un mesero: uno te deja decidir tranquilo; otro te recomienda el platillo perfecto y te lleva al postre.</p>
              <div className={styles.options}>
                {persuasionChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.persuasionLevel === value} Icon={Icon} label={label} example={example} onClick={() => patch({ persuasionLevel: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'language' && (
            <>
              <h2 className={styles.title}>¿Cómo quieres que suene?</h2>
              <p className={styles.help}>El tono con el que escribe. Como elegir si saluda de "buenas tardes" o de "qué onda".</p>
              <div className={styles.options}>
                {languageChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.languageLevel === value} Icon={Icon} label={label} example={example} onClick={() => patch({ languageLevel: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'action' && (
            <>
              <h2 className={styles.title}>Cuando la persona ya está lista, ¿qué hace?</h2>
              <p className={styles.help}>El momento clave: ya convenciste, ¿ahora qué? Es como el cierre de la jugada.</p>
              <div className={styles.options}>
                {actionChoices.map(({ value, label, example, Icon }) => (
                  <OptionCard key={value} active={draft.successAction === value} Icon={Icon} label={label} example={example} onClick={() => patch({ successAction: value })} />
                ))}
              </div>
            </>
          )}

          {step === 'data' && (
            <>
              <h2 className={styles.title}>¿Qué datos debe pedir?</h2>
              <p className={styles.help}>Lo mínimo que necesitas de cada persona. Los pide de a uno, sin que se sienta formulario. <strong>Puedes dejarlo en blanco</strong> y agregarlo luego.</p>
              <textarea
                className={styles.textarea}
                value={draft.requiredData}
                rows={4}
                placeholder={'Ejemplo:\n- Nombre completo\n- Servicio que le interesa'}
                onChange={(e) => patch({ requiredData: e.target.value })}
              />
            </>
          )}

          {step === 'recap' && (
            <>
              <h2 className={styles.title}>¡Así quedó tu asistente! 🚀</h2>
              <p className={styles.help}>Revísalo de un vistazo. Si algo no te late, regresa y cámbialo. Después podrás afinar todo en el editor.</p>
              <div className={styles.recapList}>
                <RecapRow label="Se llama" value={draft.name.trim() || '—'} />
                <RecapRow label="Su misión" value={draft.objective === 'custom' ? (draft.customObjective.trim() || 'Meta propia') : labelOf(objectiveChoices, draft.objective)} />
                <RecapRow label="Habla como" value={draft.identityMode === 'custom' ? (draft.identityCustomName.trim() || 'Nombre propio') : labelOf(identityChoices, draft.identityMode)} />
                <RecapRow label="Estilo de venta" value={labelOf(persuasionChoices, draft.persuasionLevel)} />
                <RecapRow label="Forma de hablar" value={labelOf(languageChoices, draft.languageLevel)} />
                <RecapRow label="Al estar listo" value={labelOf(actionChoices, draft.successAction)} />
                <RecapRow label="Pide datos" value={draft.requiredData.trim() ? 'Sí' : 'No por ahora'} />
              </div>
            </>
          )}
        </div>

        <div className={styles.footer}>
          {stepIndex > 0
            ? <Button variant="ghost" onClick={goBack} disabled={creating}><ArrowLeft size={16} /> Atrás</Button>
            : <span />}
          <div className={styles.footerRight}>
            {step === 'welcome' && <Button variant="primary" onClick={goNext}>Empezar <ArrowRight size={16} /></Button>}
            {questionNumber !== null && <Button variant="primary" onClick={goNext} disabled={!canAdvance}>Siguiente <ArrowRight size={16} /></Button>}
            {step === 'recap' && <Button variant="primary" onClick={finish} loading={creating} disabled={creating}><Rocket size={16} /> Crear asistente</Button>}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function OptionCard({ active, Icon, label, example, onClick }: { active: boolean; Icon: LucideIcon; label: string; example: string; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.optionCard} ${active ? styles.optionCardActive : ''}`} onClick={onClick} aria-pressed={active}>
      <span className={styles.optionIcon}><Icon size={20} /></span>
      <span className={styles.optionBody}>
        <span className={styles.optionLabel}>{label}</span>
        <span className={styles.optionExample}>{example}</span>
      </span>
    </button>
  )
}

function RecapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.recapRow}>
      <span className={styles.recapKey}>{label}</span>
      <span className={styles.recapVal}>{value}</span>
    </div>
  )
}
