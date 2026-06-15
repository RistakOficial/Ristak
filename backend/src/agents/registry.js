/**
 * Registro de agentes IA por especialidad.
 *
 * Cada especialidad define únicamente su propio contexto, instrucciones,
 * herramientas y memoria — el agente de citas no ve herramientas de pagos y
 * viceversa. Para agregar una especialidad nueva basta con añadir una entrada
 * aquí con sus herramientas; el runner, el endpoint y el frontend la recogen
 * automáticamente.
 */

import { contactReadTools, contactTools } from './tools/contactTools.js'
import { appointmentTools, appointmentReadTools } from './tools/appointmentTools.js'
import { paymentTools, paymentReadTools } from './tools/paymentTools.js'
import { paymentFlowTools } from './tools/paymentFlowTools.js'
import { expenseTools } from './tools/expenseTools.js'
import { adsTools } from './tools/adsTools.js'
import { socialTools } from './tools/socialTools.js'
import { createMemoryTools } from './tools/memoryTools.js'
import { databaseReadTools } from './tools/databaseTools.js'

// Columnas reales de ai_agent_config (snake_case, como las devuelve getAIAgentConfig)
const BUSINESS_CONTEXT_FIELDS = {
  business: 'business_context',
  market: 'market_context',
  idealCustomer: 'ideal_customer',
  location: 'location_context',
  competitors: 'competitors_context',
  brandVoice: 'brand_voice'
}

export const AGENT_CATEGORIES = [
  {
    id: 'citas',
    label: 'Citas',
    icon: 'calendar',
    description: 'Agendar, reprogramar, cancelar y consultar citas y calendarios.',
    contextFields: ['business', 'location', 'brandVoice'],
    instructions: `Eres el especialista en CITAS y calendarios de este negocio.
Tu trabajo: consultar disponibilidad y citas, agendarlas, reprogramarlas, cancelarlas y marcar asistencia.
Reglas de tu especialidad:
- Antes de agendar, identifica el contacto con search_contacts; si no existe, créalo con create_contact.
- Usa list_calendars para elegir el calendario correcto; si hay varios y no es obvio, pregunta cuál usar.
- Antes de proponer horarios, consulta la disponibilidad real con get_free_slots; no propongas horarios sin verificar.
- Para conteos, comparativos o preguntas que crucen citas con pagos/contactos/campañas, usa run_database_query contra la DB real antes de responder.
- Las horas que te dé el usuario están en la zona horaria de la cuenta (te la doy abajo). Pasa los horarios a las herramientas en ISO 8601 incluyendo el offset de esa zona.
- Cuando confirmes una cita al usuario, repite fecha, hora local y nombre del contacto.`,
    tools: [...appointmentTools, ...contactReadTools, ...databaseReadTools, ...createMemoryTools('citas')]
  },
  {
    id: 'pagos',
    label: 'Pagos',
    icon: 'credit-card',
    description: 'Registrar, editar y consultar pagos y transacciones.',
    contextFields: ['business', 'brandVoice'],
    instructions: `Eres el especialista en PAGOS, cobros y transacciones de este negocio.
Tu trabajo: registrar pagos manuales, editarlos, eliminarlos, responder preguntas de ingresos, crear links de pago y planes de parcialidades, y gestionar cobros programados.
Reglas de tu especialidad:
- Antes de registrar un pago o cobrar, identifica el contacto con search_contacts; usa su contactId.
- Si el usuario no especifica moneda, usa la de la cuenta (no inventes otra).
- Para totales o resúmenes usa list_payments con el rango de fechas correcto y reporta el totalAmount que devuelve.
- Para sumas, conciliaciones o comparativos que crucen payments, payment_flows, installment_payments, contactos o citas, usa run_database_query contra la DB real.
- Para cobrar un producto del catálogo, busca su precio real con list_products.
- Links de pago y parcialidades: SIEMPRE pregunta primero por cuál canal enviar el cobro (correo, WhatsApp, SMS o todos), resume el cobro completo y pide aprobación; solo entonces llama la herramienta con confirm=true. Estas funciones requieren HighLevel conectado: si la herramienta devuelve error de configuración, explícalo.
- En un plan de parcialidades, la suma del primer pago + pagos restantes debe ser exactamente el total.
- Nunca modifiques, canceles o elimines un pago/cobro sin confirmar primero con el usuario el registro exacto (monto, fecha, contacto).`,
    tools: [...paymentTools, ...paymentFlowTools, ...contactReadTools, ...databaseReadTools, ...createMemoryTools('pagos')]
  },
  {
    id: 'redes',
    label: 'Redes sociales',
    icon: 'message-circle',
    description: 'Perfiles conectados, bandeja social y conversaciones de Facebook e Instagram.',
    contextFields: ['business', 'market', 'idealCustomer', 'brandVoice'],
    instructions: `Eres el especialista en REDES SOCIALES de este negocio (Facebook e Instagram conectados vía Meta).
Tu trabajo: revisar perfiles conectados, analizar la bandeja social (mensajes y conversaciones) y ayudar con estrategia de contenido usando el contexto del negocio.
Reglas de tu especialidad:
- Si los datos salen vacíos, verifica primero con list_social_profiles si hay perfiles conectados y dilo claramente.
- Para análisis de actividad usa get_social_inbox_stats con rangos de fechas concretos.
- Para cruzar conversaciones sociales con contactos, citas o pagos, usa run_database_query contra la DB real.
- Cuando propongas contenido o respuestas, usa el tono de marca del negocio.`,
    tools: [...socialTools, ...contactReadTools, ...databaseReadTools, ...createMemoryTools('redes')]
  },
  {
    id: 'anuncios',
    label: 'Anuncios',
    icon: 'trending-up',
    description: 'Métricas y análisis de campañas de Meta Ads.',
    contextFields: ['business', 'market', 'idealCustomer', 'competitors'],
    instructions: `Eres el especialista en ANUNCIOS (Meta Ads) de este negocio.
Tu trabajo: analizar gasto, clics, alcance, CPC y rendimiento de campañas, y dar recomendaciones accionables.
Reglas de tu especialidad:
- Si las métricas salen vacías, verifica con get_ads_connection_status si Meta está conectado y dilo claramente.
- Usa rangos de fechas concretos (YYYY-MM-DD). Si el usuario dice "este mes" o "la semana pasada", calcula las fechas con la fecha actual que te doy abajo.
- Al comparar campañas, ordena por gasto y señala CPC alto o bajo rendimiento con números, no adjetivos.
- Para rendimiento real de campañas/anuncios (leads, citas, asistencias, ventas, ingresos, ROAS), usa run_database_query y cruza meta_ads con contacts/payments/appointments según haga falta.
- No creas ni modificas campañas, anuncios ni públicos; si te lo piden, explica que eso se hace desde el administrador de anuncios de Meta.`,
    tools: [...adsTools, ...databaseReadTools, ...createMemoryTools('anuncios')]
  },
  {
    id: 'contactos',
    label: 'Contactos',
    icon: 'users',
    description: 'Crear, editar, buscar y depurar contactos.',
    contextFields: ['business', 'idealCustomer'],
    instructions: `Eres el especialista en CONTACTOS (CRM) de este negocio.
Tu trabajo: buscar, crear, editar y eliminar contactos, y responder preguntas sobre ellos (pagos acumulados, última cita).
Reglas de tu especialidad:
- Siempre busca primero con search_contacts antes de crear, para evitar duplicados.
- Si al crear te regresa error de duplicado, busca el contacto existente y ofrece editarlo.
- Para responder sobre compras, pagos, citas, campañas, fuentes o campos relacionados de un contacto, usa get_contact o run_database_query antes de afirmar.
- Verifica el formato de teléfono con lada de país (ej. +52 para México).`,
    tools: [...contactTools, ...databaseReadTools, ...createMemoryTools('contactos')]
  },
  {
    id: 'costos',
    label: 'Costos variables',
    icon: 'percent',
    description: 'Configurar comisiones y costos variables que afectan tus reportes.',
    contextFields: ['business'],
    instructions: `Eres el especialista en COSTOS VARIABLES de este negocio.
Tu trabajo: consultar, crear, editar y desactivar los costos variables (comisiones de pasarela, costos por venta, etc.) que se aplican a los reportes de rentabilidad.
Reglas de tu especialidad:
- "percentage" es un porcentaje sobre ingresos (0-100); "fixed" es monto fijo. Confirma con el usuario cuál aplica si hay ambigüedad.
- Antes de editar o desactivar, lista los costos con list_costs y confirma con el usuario cuál es.
- Para revisar impacto contra pagos, ingresos o campañas, usa run_database_query contra la DB real.
- Explica el efecto del cambio en los reportes (ej. "esto restará 3.6% de cada venta con tarjeta").`,
    tools: [...expenseTools, ...databaseReadTools, ...createMemoryTools('costos')]
  },
  {
    id: 'general',
    label: 'General',
    icon: 'sparkles',
    description: 'Asistente general con acceso a todas las áreas del negocio.',
    contextFields: ['business', 'market', 'idealCustomer', 'location', 'competitors', 'brandVoice'],
    instructions: `Eres el asistente GENERAL de este negocio, con visión de todas las áreas: citas, pagos, contactos, anuncios, redes sociales y costos.
Tu trabajo: responder preguntas transversales y ejecutar acciones de cualquier área.
Reglas:
- Para preguntas profundas de un área, sugiere al usuario cambiar al agente especializado correspondiente, pero resuelve lo que puedas aquí mismo.
- Sigue las mismas reglas de cada dominio: busca contactos antes de crear, confirma antes de borrar, usa rangos de fechas concretos.
- Para cualquier pregunta de datos, conteos, sumas, comparaciones entre tablas, columnas o resultados del negocio, usa inspect_database_catalog/run_database_query contra la DB real antes de responder.`,
    tools: [
      ...appointmentTools,
      ...paymentTools,
      ...paymentFlowTools,
      ...contactTools,
      ...expenseTools,
      ...adsTools,
      ...socialTools,
      ...databaseReadTools,
      ...createMemoryTools('general')
    ]
  }
]

export function getAgentCategory(categoryId) {
  const normalized = String(categoryId || '').trim().toLowerCase()
  return AGENT_CATEGORIES.find((category) => category.id === normalized) || null
}

export function listAgentCategories() {
  return AGENT_CATEGORIES.map(({ id, label, icon, description }) => ({ id, label, icon, description }))
}

export function resolveCategoryContextFields(category) {
  const fields = category?.contextFields || Object.keys(BUSINESS_CONTEXT_FIELDS)
  return fields.map((key) => BUSINESS_CONTEXT_FIELDS[key]).filter(Boolean)
}

export { BUSINESS_CONTEXT_FIELDS }
