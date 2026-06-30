import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Sparkles, Calendar, ShoppingBag, ClipboardList, Filter, Wand2,
  Building2, User, Coffee, Compass, Target, Briefcase, Smile, MessageCircle,
  UserCheck, CalendarCheck, CreditCard, Link2, Wallet, ShieldCheck, Users, Rocket, type LucideIcon
} from 'lucide-react'
import { Modal, Button, CustomSelect, NumberInput } from '@/components/common'
import type { ConversationalAIProviderId } from '@/constants/conversationalAIProviders'
import { useAccountCurrency } from '@/hooks'
import { calendarsService, type Calendar as CalendarRecord } from '@/services/calendarsService'
import { formatCurrency } from '@/utils/format'
import {
  type AgentIdentityMode,
  type ConversationalAgentDefInput,
  type ConversationalLanguageLevel,
  type ConversationalObjective,
  type ConversationalPersuasionLevel,
  type ConversationalSuccessAction
} from '@/services/conversationalAgentService'
import {
  buildInitialAgentWizardDraft as buildInitialDraft,
  buildOverridesFromDraft,
  isAgentWizardCitasBooking as isCitasBooking,
  isAgentWizardVentasCharging as isVentasCharging,
  type AgentWizardDraft
} from './agentCreationWizardModel'
import { StepArt } from './AgentCreationWizardArt'
import { WizardTestChat } from './WizardTestChat'
import styles from './AgentCreationWizard.module.css'

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

type StepId =
  | 'welcome' | 'name' | 'objective' | 'identity' | 'persuasion' | 'language'
  | 'action' | 'calendar' | 'payment' | 'data' | 'scope' | 'recap' | 'test'

interface Props {
  isOpen: boolean
  onClose: () => void
  onComplete: (overrides: ConversationalAgentDefInput) => void | Promise<void>
  onSkipToManual?: () => void
  creating?: boolean
  defaultName?: string
  aiProvider?: ConversationalAIProviderId
  model?: string
}

export function AgentCreationWizard({ isOpen, onClose, onComplete, onSkipToManual, creating = false, defaultName = '', aiProvider, model }: Props) {
  const [stepIndex, setStepIndex] = useState(0)
  const [draft, setDraft] = useState<AgentWizardDraft>(() => buildInitialDraft(defaultName))
  const [calendars, setCalendars] = useState<CalendarRecord[]>([])
  const [testResetKey, setTestResetKey] = useState(0)
  const [accountCurrency] = useAccountCurrency()

  // Reinicia el wizard cada vez que se abre y carga los calendarios reales.
  useEffect(() => {
    if (!isOpen) return
    setStepIndex(0)
    setTestResetKey((k) => k + 1)
    setDraft(buildInitialDraft(defaultName))
    let alive = true
    calendarsService.getCalendars()
      .then((list) => { if (alive) setCalendars((list || []).filter((c) => c.isActive)) })
      .catch(() => { if (alive) setCalendars([]) })
    return () => { alive = false }
  }, [isOpen, defaultName])

  // Pasos ACTIVOS según las respuestas (if/if-not). El calendario y el cobro solo
  // aparecen cuando aplican; si no, ni se ven.
  const activeSteps = useMemo<StepId[]>(() => {
    const showCalendar = isCitasBooking(draft)
    const showPayment = isCitasBooking(draft) || isVentasCharging(draft)
    return [
      'welcome', 'name', 'objective', 'identity', 'persuasion', 'language', 'action',
      ...(showCalendar ? ['calendar'] as StepId[] : []),
      ...(showPayment ? ['payment'] as StepId[] : []),
      'data', 'scope', 'recap', 'test'
    ]
  }, [draft.objective, draft.successAction])

  // Si la lista de pasos se acorta (p.ej. cambió la acción), no dejes el índice fuera de rango.
  useEffect(() => {
    setStepIndex((i) => Math.min(i, activeSteps.length - 1))
  }, [activeSteps.length])

  const safeIndex = Math.min(stepIndex, activeSteps.length - 1)
  const step = activeSteps[safeIndex]
  const isQuestion = step !== 'welcome' && step !== 'recap' && step !== 'test'
  // El denominador es dinámico a propósito: al elegir que la IA agende/cobre aparecen
  // pasos reales nuevos, así que "Pregunta X de N" sube N de forma honesta.
  const totalQuestions = activeSteps.length - 3 // sin bienvenida, resumen ni prueba
  const questionNumber = isQuestion ? safeIndex : null
  const actionChoices = actionChoicesByObjective[draft.objective] || actionChoicesByObjective.citas

  const reconfigure = () => {
    setTestResetKey((k) => k + 1)
    setStepIndex(0)
  }

  const patch = (next: Partial<AgentWizardDraft>) => setDraft((current) => ({ ...current, ...next }))

  const chooseObjective = (objective: ConversationalObjective) => {
    const firstAction = (actionChoicesByObjective[objective] || actionChoicesByObjective.citas)[0]?.value || 'ready_for_human'
    patch({ objective, successAction: firstAction, ...(objective === 'custom' ? {} : { customObjective: '' }) })
  }

  const needsDepositAmount = (isCitasBooking(draft) && draft.askDeposit) || (isVentasCharging(draft) && draft.paymentMode === 'deposit')

  const canAdvance = useMemo(() => {
    if (step === 'name') return draft.name.trim().length > 0
    if (step === 'objective' && draft.objective === 'custom') return draft.customObjective.trim().length > 0
    // Si pide anticipo/pago, exige el monto: sin él el backend deja el avance atascado.
    if (step === 'payment' && needsDepositAmount) return Number(draft.depositAmount) > 0
    return true
  }, [step, draft, needsDepositAmount])

  const currentOverrides = () => buildOverridesFromDraft(draft, accountCurrency, defaultName || draft.name || 'Agente', { aiProvider, model })

  const goNext = () => setStepIndex((i) => Math.min(i + 1, activeSteps.length - 1))
  const goBack = () => setStepIndex((i) => Math.max(i - 1, 0))
  const finish = () => { void onComplete(currentOverrides()) }

  const labelOf = <T extends string>(choices: Array<Choice<T>>, value: T) => choices.find((c) => c.value === value)?.label || ''
  const money = (amount: number | null) => (amount && amount > 0 ? formatCurrency(amount, accountCurrency) : 'monto pendiente')

  const cobroRecap = (() => {
    if (isCitasBooking(draft)) return draft.askDeposit ? `Anticipo de ${money(draft.depositAmount)}` : 'Sin anticipo'
    if (isVentasCharging(draft)) return draft.paymentMode === 'deposit' ? `Anticipo de ${money(draft.depositAmount)}` : 'Pago completo'
    return ''
  })()

  return (
    <Modal isOpen={isOpen} onClose={onClose} type="custom" size="md" flushContent title="Nuevo asistente">
      <div className={styles.wizard}>
        {questionNumber !== null && (
          <div className={styles.progress}>
            <span className={styles.progressText}>Pregunta {questionNumber} de {totalQuestions}</span>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${(questionNumber / totalQuestions) * 100}%` }} />
            </div>
          </div>
        )}

        <div className={styles.body}>
          {step !== 'test' && <div className={styles.art}><StepArt kind={step} /></div>}

          {step === 'welcome' && (
            <>
              <h2 className={styles.title}>Vamos a crear tu asistente 🎉</h2>
              <p className={styles.help}>Te voy a hacer <strong>unas preguntas rapiditas</strong>, una por una, con ejemplos. No hay respuestas malas y todo lo puedes cambiar después. ¡Hasta un niño lo arma!</p>
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

          {step === 'calendar' && (
            <>
              <h2 className={styles.title}>¿En qué calendario aparta las citas?</h2>
              <p className={styles.help}>Aquí caen las citas que la IA agende. Si no eliges, ella revisa todos tus calendarios activos y acomoda donde haya hueco real.</p>
              <div className={styles.field}>
                <CustomSelect value={draft.calendarId || ''} onValueChange={(value) => patch({ calendarId: value || null })} portal>
                  <option value="">Que elija entre mis calendarios</option>
                  {calendars.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </CustomSelect>
                <p className={styles.fieldHint}>Puedes cambiarlo o afinar horarios después en el editor.</p>
              </div>
            </>
          )}

          {step === 'payment' && draft.objective === 'citas' && (
            <>
              <h2 className={styles.title}>¿Pides anticipo para apartar la cita?</h2>
              <p className={styles.help}>Si cobras algo por adelantado para reservar el lugar, la IA lo pide y espera el comprobante antes de agendar.</p>
              <div className={styles.options}>
                <OptionCard active={!draft.askDeposit} Icon={CalendarCheck} label="No, agenda directo" example="Aparta la cita sin cobrar nada antes." onClick={() => patch({ askDeposit: false })} />
                <OptionCard active={draft.askDeposit} Icon={Wallet} label="Sí, pido anticipo" example="Pide el anticipo, valida el comprobante y luego aparta." onClick={() => patch({ askDeposit: true })} />
              </div>
              {draft.askDeposit && (
                <MoneyField label="¿Cuánto de anticipo?" amount={draft.depositAmount} currency={accountCurrency} onChange={(v) => patch({ depositAmount: v })} />
              )}
            </>
          )}

          {step === 'payment' && draft.objective === 'ventas' && (
            <>
              <h2 className={styles.title}>¿Cómo cobras?</h2>
              <p className={styles.help}>Define si la persona paga todo de una o solo deja un anticipo para apartar.</p>
              <div className={styles.options}>
                <OptionCard active={draft.paymentMode === 'full_payment'} Icon={CreditCard} label="Pago completo" example="Cobra el total. La venta se cierra cuando entra el pago entero." onClick={() => patch({ paymentMode: 'full_payment' })} />
                <OptionCard active={draft.paymentMode === 'deposit'} Icon={Wallet} label="Solo anticipo" example="Cobra una parte para apartar. El resto se ve después." onClick={() => patch({ paymentMode: 'deposit' })} />
              </div>
              {draft.paymentMode === 'deposit' && (
                <MoneyField label="¿De cuánto es el anticipo?" amount={draft.depositAmount} currency={accountCurrency} onChange={(v) => patch({ depositAmount: v })} />
              )}
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

          {step === 'scope' && (
            <>
              <h2 className={styles.title}>¿Y con los contactos que ya tienes?</h2>
              <p className={styles.help}>Esto es por seguridad: muchos de tus contactos ya son clientes. Decide si este asistente también puede escribirles, o si solo atiende a los nuevos para no mezclarse.</p>
              <div className={styles.options}>
                <OptionCard
                  active={draft.contactScope === 'new_only'}
                  Icon={ShieldCheck}
                  label="Solo los nuevos desde hoy"
                  example="Ignora a tus contactos de antes. Solo atiende a quien te escriba de ahora en adelante. (Lo más seguro.)"
                  onClick={() => patch({ contactScope: 'new_only' })}
                />
                <OptionCard
                  active={draft.contactScope === 'all'}
                  Icon={Users}
                  label="Atender a todos"
                  example="Puede tomar tanto a tus contactos actuales como a los nuevos. Útil si quieres que se haga cargo de todo."
                  onClick={() => patch({ contactScope: 'all' })}
                />
              </div>
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
                {isCitasBooking(draft) && (
                  <RecapRow label="Calendario" value={calendars.find((c) => c.id === draft.calendarId)?.name || 'El que tenga hueco'} />
                )}
                {cobroRecap && <RecapRow label="Cobro" value={cobroRecap} />}
                <RecapRow label="Atiende a" value={draft.contactScope === 'new_only' ? 'Solo contactos nuevos' : 'Todos (nuevos y actuales)'} />
                <RecapRow label="Pide datos" value={draft.requiredData.trim() ? 'Sí' : 'No por ahora'} />
              </div>
            </>
          )}

          {step === 'test' && (
            <>
              <h2 className={styles.title}>Pruébalo antes de soltarlo 🎙️</h2>
              <p className={styles.help}>Aquí está tu asistente, vivito. Escríbele como si fueras un cliente: mándale un mensaje, déjale una <strong>nota de voz</strong>, súbele una <strong>foto</strong> o un comprobante. Pruébalo a lo bestia para ver cómo responde ANTES de activarlo.</p>
              <div className={styles.testChat}>
                <WizardTestChat
                  key={testResetKey}
                  agentName={draft.name}
                  getConfig={currentOverrides}
                />
              </div>
              <p className={styles.fieldHint}>Tip: pídele una cita, pregúntale precios, o mándale un audio a ver si te entiende. Si algo no te late, reconfigúralo.</p>
            </>
          )}
        </div>

        <div className={styles.footer}>
          {safeIndex > 0
            ? <Button variant="ghost" onClick={goBack} disabled={creating}><ArrowLeft size={16} /> Atrás</Button>
            : <span />}
          <div className={styles.footerRight}>
            {step === 'welcome' && <Button variant="primary" onClick={goNext}>Empezar <ArrowRight size={16} /></Button>}
            {questionNumber !== null && <Button variant="primary" onClick={goNext} disabled={!canAdvance}>Siguiente <ArrowRight size={16} /></Button>}
            {step === 'recap' && <Button variant="primary" onClick={goNext}>Probar mi asistente <ArrowRight size={16} /></Button>}
            {step === 'test' && (
              <>
                <Button variant="ghost" onClick={reconfigure} disabled={creating}>No me late, reconfigurar</Button>
                <Button variant="primary" onClick={finish} loading={creating} disabled={creating}><Rocket size={16} /> Me encanta, créalo</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function MoneyField({ label, amount, currency, onChange }: { label: string; amount: number | null; currency: string; onChange: (value: number) => void }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <div className={styles.moneyInputWrap}>
        <span className={styles.moneyPrefix}>$</span>
        <NumberInput
          className={`${styles.input} ${styles.moneyInput}`}
          min={0}
          step={50}
          value={amount ?? ''}
          onValueChange={onChange}
          placeholder="0"
        />
      </div>
      <p className={styles.fieldHint}>Se usa la moneda de tu cuenta ({currency}). Pon el monto que cobras de anticipo para continuar.</p>
    </div>
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
