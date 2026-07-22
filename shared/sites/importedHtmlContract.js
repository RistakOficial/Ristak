export const IMPORTED_HTML_MOBILE_BREAKPOINT_PX = 640
export const IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX = 390

export const IMPORTED_HTML_MOBILE_RULES = Object.freeze([
  'Incluye <meta name="viewport" content="width=device-width, initial-scale=1"> en cada documento HTML.',
  `Diseña una versión móvil real y fluida. Incluye reglas @media (max-width: ${IMPORTED_HTML_MOBILE_BREAKPOINT_PX}px) con cambios concretos; no basta con reducir visualmente la versión de escritorio.`,
  `Valida el resultado en un viewport de ${IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX}px: no debe existir scroll horizontal, contenido cortado ni texto, botones, formularios, imágenes, videos o iframes fuera del ancho visible.`,
  'En móvil convierte grids y filas de varias columnas a una sola columna cuando sea necesario, conserva el orden lógico del contenido y usa padding lateral seguro.',
  'Usa anchos fluidos (width: 100% y max-width), min-width: 0 y box-sizing: border-box. Evita anchos fijos, min-width de escritorio y 100vw dentro de contenedores con padding.',
  'Imágenes, video, audio e iframes deben respetar max-width: 100%; las imágenes y videos conservan su proporción con height: auto o aspect-ratio.',
  'Si necesitas archivos de video distintos para computadora y móvil, declara dos slots nativos con la misma base semántica y sufijos claros, por ejemplo video-presentacion-desktop y video-presentacion-mobile. Muéstralos con la media query real; Ristak enlaza el panel con la variante visible y usa la configurada como respaldo mientras la otra siga pendiente.',
  'Controles táctiles deben medir al menos 44px de alto. En móvil, inputs, selects y textareas usan font-size de al menos 16px para evitar zoom automático del navegador.',
  'No simules móvil con zoom, transform: scale ni una captura encogida. El CSS responsive debe reaccionar al ancho real del viewport.',
  'Cuando edites una página existente, conserva sus media queries y vuelve a revisar escritorio y móvil. Un cambio de escritorio no puede romper la versión móvil ni viceversa.'
])

export const IMPORTED_HTML_CUSTOM_CALENDAR_RULES = Object.freeze([
  'El calendario custom debe ser una experiencia completa tipo Calendly, no un input de fecha aislado ni un select permanente de horarios.',
  'Usa un único contenedor raíz con data-rstk-native-element="calendar", data-rstk-native-id estable y data-rstk-native-render="custom". El HTML y el CSS controlan por completo el diseño; Ristak controla el mes vigente, disponibilidad real, zona horaria, selección y reserva.',
  'Construye cuatro pasos dentro del mismo componente: data-rstk-calendar-step="date", "time", "form" y "success". Deja time, form y success con hidden al cargar; Ristak cambia el paso y el atributo data-rstk-calendar-state del contenedor.',
  'En date incluye navegación mensual con data-rstk-calendar-prev-month, data-rstk-calendar-month-label y data-rstk-calendar-next-month; muestra encabezados visibles de domingo a sábado y deja un contenedor vacío data-rstk-calendar-days con layout CSS de 7 columnas.',
  'Ristak llena data-rstk-calendar-days con todos los días del mes. El CSS debe contemplar [data-rstk-calendar-day][data-state="available"], [data-state="unavailable"], [data-state="outside"] y [data-selected="true"]. Los días sin disponibilidad llegan deshabilitados; no hardcodees fechas ni decidas disponibilidad en HTML.',
  'En time incluye data-rstk-calendar-selected-date, data-rstk-calendar-back-to-dates y un contenedor vacío data-rstk-calendar-slots. Ristak genera un botón por horario real con data-rstk-calendar-slot y data-selected="true|false"; estiliza esos selectores para que los horarios se elijan como botones, no como un simple select.',
  'En form incluye data-rstk-calendar-selected-datetime, data-rstk-calendar-back-to-times y un <form data-rstk-calendar-book-form data-rstk-form-id="agenda-reserva" data-rstk-label="Reserva de cita">. Nombre, email y teléfono usan respectivamente data-rstk-calendar-name, data-rstk-calendar-email y data-rstk-calendar-phone, además de data-rstk-field-id estable; data-rstk-calendar-notes es opcional.',
  'Los atributos data-rstk-calendar-* NO sustituyen data-rstk-field-id: cada campo guardable conserva su identidad estable aunque cambien el copy, name, id, clases o posición.',
  'En success incluye un elemento data-rstk-calendar-success. Fuera o dentro de los pasos agrega data-rstk-calendar-message con role="status" para carga, falta de cupo y errores.',
  'Puedes mostrar la zona activa con data-rstk-calendar-timezone-label. Si agregas un select data-rstk-calendar-timezone, sus opciones deben ser zonas IANA válidas; Ristak vuelve a agrupar los instantes al cambiarla.',
  'No agregues JavaScript de calendario, fetch, fechas, slots ni submit. Ristak consulta el calendario asociado, agrupa los instantes UTC para la zona mostrada, Ristak vuelve a validar el horario al reservar y ejecuta la acción posterior configurada.',
  'El grid, los horarios y el formulario deben ser responsive: sin scroll horizontal a 390px, controles táctiles de al menos 44px y una jerarquía clara entre elegir fecha, elegir hora y completar datos.'
])

export const IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON = `<section data-rstk-native-element="calendar" data-rstk-native-id="agenda-custom" data-rstk-native-render="custom" data-rstk-label="Agenda principal">
  <section data-rstk-calendar-step="date">
    <header><button type="button" data-rstk-calendar-prev-month aria-label="Mes anterior">‹</button><strong data-rstk-calendar-month-label></strong><button type="button" data-rstk-calendar-next-month aria-label="Mes siguiente">›</button></header>
    <div data-rstk-calendar-weekdays aria-hidden="true"><span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span></div>
    <div data-rstk-calendar-days></div>
  </section>
  <section data-rstk-calendar-step="time" hidden><button type="button" data-rstk-calendar-back-to-dates>Cambiar fecha</button><h3 data-rstk-calendar-selected-date></h3><div data-rstk-calendar-slots></div></section>
  <section data-rstk-calendar-step="form" hidden><button type="button" data-rstk-calendar-back-to-times>Cambiar horario</button><p data-rstk-calendar-selected-datetime></p><form data-rstk-calendar-book-form data-rstk-form-id="agenda-reserva" data-rstk-label="Reserva de cita"><label>Nombre<input name="name" autocomplete="name" data-rstk-calendar-name data-rstk-field-id="agenda-nombre" required></label><label>Correo<input type="email" name="email" autocomplete="email" data-rstk-calendar-email data-rstk-field-id="agenda-email" required></label><label>Teléfono<input type="tel" name="phone" autocomplete="tel" data-rstk-calendar-phone data-rstk-field-id="agenda-telefono" required></label><button type="submit">Confirmar cita</button></form></section>
  <section data-rstk-calendar-step="success" hidden><p data-rstk-calendar-success></p></section>
  <p data-rstk-calendar-message role="status" aria-live="polite"></p>
</section>`

export function buildImportedHtmlMobileRulesText(heading = 'Versión móvil obligatoria:') {
  return [heading, ...IMPORTED_HTML_MOBILE_RULES.map(rule => `- ${rule}`)].join('\n')
}

export function buildImportedHtmlCustomCalendarRulesText(heading = 'Calendario HTML avanzado conectado a Ristak:') {
  return [
    heading,
    ...IMPORTED_HTML_CUSTOM_CALENDAR_RULES.map(rule => `- ${rule}`),
    '- Estructura mínima obligatoria (agrega clases y CSS propios sin quitar los hooks):',
    IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON
  ].join('\n')
}

export const IMPORTED_HTML_CUSTOM_SOCIAL_PROFILE_RULES = Object.freeze([
  'Usa un único contenedor raíz con data-rstk-native-element="social-profile", data-rstk-native-id estable y data-rstk-native-render="custom". Dentro son obligatorios <img data-rstk-social-avatar alt="">, data-rstk-social-name, data-rstk-social-followers y el badge completo data-rstk-social-verified; data-rstk-social-platform y data-rstk-social-subtitle son opcionales.',
  'El contenedor raíz del perfil debe medir únicamente lo que ocupa su contenido. No le pongas height, min-height, max-height, block-size, min-block-size, max-block-size, aspect-ratio, unidades de viewport como vh/svh/dvh, flex-grow, flex: 1, estiramiento de grid ni márgenes o padding verticales usados para reservar espacio.',
  'Cierra el contenedor raíz inmediatamente después del diseño visual del perfil. El hero, texto, video, formulario y cualquier contenido posterior deben quedar fuera del perfil social.',
  'Si el diseño necesita portada, fondo grande, superposición o separación externa, créalos en un contenedor padre o hermano. El perfil conectado conserva altura intrínseca y el padre controla la composición de la sección.',
  'No inventes foto, nombre, seguidores, plataforma ni estado verificado y no llames Meta desde el navegador. Ristak inyecta los datos reales y oculta el elemento completo data-rstk-social-verified cuando el usuario apaga esa opción.',
  'Comprueba escritorio y un viewport móvil de 390px: después del perfil debe comenzar el siguiente contenido con el espaciado normal del diseño, sin un bloque vacío ni una altura de pantalla completa.'
])

export function buildImportedHtmlCustomSocialProfileRulesText(heading = 'Perfil social HTML conectado a Ristak:') {
  return [heading, ...IMPORTED_HTML_CUSTOM_SOCIAL_PROFILE_RULES.map(rule => `- ${rule}`)].join('\n')
}

export const IMPORTED_HTML_VIDEO_ACTION_TARGET_RULES = Object.freeze([
  'Prepara desde el inicio todos los elementos visibles que una acción de video podría controlar, aunque todavía no exista ninguna regla ni se haya elegido mostrar u ocultar algo en el editor.',
  'Cada CTA, botón, enlace, formulario, sección, bloque de texto, título, imagen, figura y slot nativo controlable debe tener un data-rstk-video-action-target semántico, estable y único en su página, además de data-rstk-label con un nombre humano reconocible en el panel.',
  'Conserva exactamente esos identificadores al cambiar copy, clases, estilos, posición o diseño responsive. No recicles un identificador para otro elemento y no uses índices visuales frágiles como boton-1 cuando exista un nombre de negocio como aplicar-ahora.',
  'Marca el elemento completo que debe aparecer, ocultarse, desplazarse o cambiar; no marques spans, iconos o wrappers internos si la acción debe controlar el botón, tarjeta o sección completa.',
  'Los interiores de form, calendar, payment, video o social-profile nativos pertenecen a Ristak: marca el slot raíz si debe ser controlable, pero no agregues targets a sus controles internos.',
  'data-rstk-video-rules referencia exclusivamente esos valores mediante targetBlockIds. No escribas JavaScript para ocultar, mostrar, medir progreso ni reaccionar al reproductor; Ristak aplica el estado inicial y ejecuta la acción en preview y publicado.'
])

export function buildImportedHtmlVideoActionTargetRulesText(heading = 'Elementos controlables por acciones de video:') {
  return [heading, ...IMPORTED_HTML_VIDEO_ACTION_TARGET_RULES.map(rule => `- ${rule}`)].join('\n')
}

const IMPORTED_VIDEO_ACTION_TARGET_ATTRS = [
  'data-rstk-video-action-target',
  'data-ristak-video-action-target',
  'data-ristack-video-action-target'
]

const IMPORTED_VIDEO_ACTION_IDENTITY_ATTRS = [
  'id',
  'data-rstk-section',
  'data-ristak-section',
  'data-ristack-section',
  'data-rstk-form-id',
  'data-ristak-form-id',
  'data-ristack-form-id',
  'data-rstk-native-id',
  'data-ristak-native-id',
  'data-ristack-native-id',
  'data-rstk-element-id',
  'data-ristak-element-id',
  'data-ristack-element-id',
  'data-rstk-edit-id',
  'data-ristak-edit-id',
  'data-ristack-edit-id',
  'data-rstk-asset-id',
  'data-ristak-asset-id',
  'data-ristack-asset-id',
  'data-rstk-background-asset-id',
  'data-ristak-background-asset-id',
  'data-ristack-background-asset-id'
]

const IMPORTED_VIDEO_ACTION_NATIVE_ROOT_ATTRS = [
  'data-rstk-native-element',
  'data-ristak-native-element',
  'data-ristack-native-element',
  'data-rstk-element-type',
  'data-ristak-element-type',
  'data-ristack-element-type'
]

const IMPORTED_VIDEO_ACTION_SEMANTIC_TAGS = new Set([
  'article',
  'aside',
  'blockquote',
  'button',
  'details',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'img',
  'main',
  'p',
  'picture',
  'section',
  'summary'
])

const IMPORTED_VIDEO_ACTION_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'
])

const IMPORTED_VIDEO_ACTION_RAW_TEXT_TAGS = new Set([
  'script', 'style', 'template', 'textarea', 'title'
])

const IMPORTED_VIDEO_ACTION_FALLBACK_NAMES = {
  a: 'enlace',
  article: 'contenido',
  aside: 'contenido-lateral',
  blockquote: 'cita',
  button: 'boton',
  details: 'detalle',
  fieldset: 'grupo-campos',
  figure: 'figura',
  footer: 'pie',
  form: 'formulario',
  h1: 'titulo',
  h2: 'titulo',
  h3: 'titulo',
  h4: 'titulo',
  h5: 'titulo',
  h6: 'titulo',
  header: 'encabezado',
  img: 'imagen',
  input: 'boton',
  main: 'contenido-principal',
  p: 'texto',
  picture: 'imagen',
  section: 'seccion',
  summary: 'resumen'
}

function decodeImportedVideoActionAttribute(value = '') {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
}

function readImportedVideoActionAttribute(tag = '', name = '') {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(tag || '').match(new RegExp(`\\s${escaped}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+)))?`, 'i'))
  return match ? decodeImportedVideoActionAttribute(match[1] ?? match[2] ?? match[3] ?? '') : ''
}

function hasImportedVideoActionAttribute(tag = '', name = '') {
  const escaped = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\s${escaped}(?:\\s*=|\\s|/?>)`, 'i').test(String(tag || ''))
}

function firstImportedVideoActionAttribute(tag = '', names = []) {
  for (const name of names) {
    if (!hasImportedVideoActionAttribute(tag, name)) continue
    const value = readImportedVideoActionAttribute(tag, name)
    if (value) return value
  }
  return ''
}

function normalizeImportedVideoActionTargetId(value = '', fallback = 'elemento') {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return normalized || fallback
}

function getImportedVideoActionDeclaredId(tag = '') {
  const explicitTarget = firstImportedVideoActionAttribute(tag, IMPORTED_VIDEO_ACTION_TARGET_ATTRS)
  if (explicitTarget) return explicitTarget
  const identity = firstImportedVideoActionAttribute(tag, IMPORTED_VIDEO_ACTION_IDENTITY_ATTRS)
  if (identity) return identity
  const actions = firstImportedVideoActionAttribute(tag, [
    'data-rstk-button-actions',
    'data-ristak-button-actions',
    'data-ristack-button-actions'
  ])
  const actionId = actions.match(/["']id["']\s*:\s*["']([^"']+)["']/i)?.[1]
  return actionId ? normalizeImportedVideoActionTargetId(actionId) : ''
}

function isImportedVideoActionNativeRoot(tag = '') {
  return IMPORTED_VIDEO_ACTION_NATIVE_ROOT_ATTRS.some(name => hasImportedVideoActionAttribute(tag, name))
}

function isImportedVideoActionTargetable(tagName = '', tag = '', insideNativeRoot = false) {
  if (insideNativeRoot) return false
  if (firstImportedVideoActionAttribute(tag, IMPORTED_VIDEO_ACTION_TARGET_ATTRS)) return true
  if (isImportedVideoActionNativeRoot(tag)) return true
  if (IMPORTED_VIDEO_ACTION_SEMANTIC_TAGS.has(tagName)) return true
  if (tagName === 'a') {
    return hasImportedVideoActionAttribute(tag, 'href') || /data-(?:rstk|ristak|ristack)-button-action/i.test(tag)
  }
  if (tagName === 'input') {
    return ['button', 'submit', 'image'].includes(readImportedVideoActionAttribute(tag, 'type').toLowerCase())
  }
  if (['div', 'li'].includes(tagName)) {
    return Boolean(
      firstImportedVideoActionAttribute(tag, IMPORTED_VIDEO_ACTION_IDENTITY_ATTRS) ||
      firstImportedVideoActionAttribute(tag, ['data-rstk-label', 'data-ristak-label', 'data-ristack-label', 'aria-label', 'title']) ||
      ['button', 'link'].includes(readImportedVideoActionAttribute(tag, 'role').toLowerCase())
    )
  }
  return false
}

function getImportedVideoActionGeneratedBase(tagName = '', tag = '') {
  const label = firstImportedVideoActionAttribute(tag, [
    'data-rstk-label',
    'data-ristak-label',
    'data-ristack-label',
    'aria-label',
    'title',
    'name'
  ])
  if (label) return normalizeImportedVideoActionTargetId(label)
  const className = readImportedVideoActionAttribute(tag, 'class').split(/\s+/).filter(Boolean)[0] || ''
  if (className) return normalizeImportedVideoActionTargetId(`${IMPORTED_VIDEO_ACTION_FALLBACK_NAMES[tagName] || tagName}-${className}`)
  return IMPORTED_VIDEO_ACTION_FALLBACK_NAMES[tagName] || normalizeImportedVideoActionTargetId(tagName)
}

function addImportedVideoActionTargetAttribute(tag = '', targetId = '') {
  if (!tag || !targetId || hasImportedVideoActionAttribute(tag, 'data-rstk-video-action-target')) return tag
  const insertAt = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1
  const spacer = tag[insertAt - 1] === ' ' ? '' : ' '
  const safeId = String(targetId).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `${tag.slice(0, insertAt)}${spacer}data-rstk-video-action-target="${safeId}"${tag.slice(insertAt)}`
}

function scanImportedHtmlTagTokens(html = '') {
  const source = String(html || '')
  const lowerSource = source.toLowerCase()
  const tokens = []
  let cursor = 0
  let rawTextTag = ''

  while (cursor < source.length) {
    if (rawTextTag) {
      const closeIndex = lowerSource.indexOf(`</${rawTextTag}`, cursor)
      if (closeIndex < 0) break
      cursor = closeIndex
      rawTextTag = ''
    }

    const start = source.indexOf('<', cursor)
    if (start < 0) break

    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4)
      const end = commentEnd < 0 ? source.length : commentEnd + 3
      tokens.push({ start, end, token: source.slice(start, end) })
      cursor = end
      continue
    }

    const lead = source[start + 1] || ''
    if (!/[A-Za-z!/?]/.test(lead)) {
      cursor = start + 1
      continue
    }

    let end = start + 1
    let quote = ''
    while (end < source.length) {
      const character = source[end]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        end += 1
        break
      }
      end += 1
    }
    if (end > source.length || source[end - 1] !== '>') break

    const token = source.slice(start, end)
    tokens.push({ start, end, token })
    cursor = end

    const opening = token.match(/^<\s*([A-Za-z][\w:-]*)/)
    if (!opening || /^<\s*\//.test(token) || /\/\s*>$/.test(token)) continue
    const tagName = opening[1].toLowerCase()
    if (IMPORTED_VIDEO_ACTION_RAW_TEXT_TAGS.has(tagName)) rawTextTag = tagName
  }

  return tokens
}

/**
 * Completa HTML legacy con identidades deterministas para el panel/runtime de
 * acciones de video. Los hooks declarados por el autor siempre ganan; Ristak
 * solo genera un fallback para elementos semánticos que llegaron sin contrato.
 */
export function ensureImportedHtmlVideoActionTargets(html = '') {
  const source = String(html || '')
  if (!source.trim()) return source

  const reservedIds = new Set()
  const tokens = scanImportedHtmlTagTokens(source)
  for (const { token } of tokens) {
    if (!/^<\s*[A-Za-z]/.test(token) || /^<\s*\//.test(token)) continue
    const declaredId = getImportedVideoActionDeclaredId(token)
    if (declaredId) reservedIds.add(declaredId)
  }

  const usedIds = new Set()
  const fallbackCounts = new Map()
  const stack = []
  let output = ''
  let cursor = 0

  for (const tagToken of tokens) {
    const token = tagToken.token
    output += source.slice(cursor, tagToken.start)
    cursor = tagToken.end

    const closingMatch = token.match(/^<\/\s*([A-Za-z][\w:-]*)/)
    if (closingMatch) {
      const closingName = closingMatch[1].toLowerCase()
      const stackIndex = stack.map(item => item.tagName).lastIndexOf(closingName)
      if (stackIndex >= 0) stack.splice(stackIndex)
      output += token
      continue
    }

    const opening = token.match(/^<\s*([A-Za-z][\w:-]*)/)
    if (!opening || token.startsWith('<!')) {
      output += token
      continue
    }

    const tagName = opening[1].toLowerCase()
    const insideNativeRoot = stack.some(item => item.nativeRoot)
    const nativeRoot = isImportedVideoActionNativeRoot(token)
    let nextToken = token

    if (isImportedVideoActionTargetable(tagName, token, insideNativeRoot)) {
      let targetId = getImportedVideoActionDeclaredId(token)
      if (!targetId) {
        const base = getImportedVideoActionGeneratedBase(tagName, token)
        let suffix = (fallbackCounts.get(base) || 0) + 1
        fallbackCounts.set(base, suffix)
        targetId = suffix === 1 ? base : `${base}-${suffix}`
        while (reservedIds.has(targetId) || usedIds.has(targetId)) {
          suffix += 1
          fallbackCounts.set(base, suffix)
          targetId = `${base}-${suffix}`
        }
      }
      usedIds.add(targetId)
      nextToken = addImportedVideoActionTargetAttribute(token, targetId)
    }

    output += nextToken
    const selfClosing = /\/\s*>$/.test(token) || IMPORTED_VIDEO_ACTION_VOID_TAGS.has(tagName)
    if (!selfClosing) stack.push({ tagName, nativeRoot: insideNativeRoot || nativeRoot })
  }

  output += source.slice(cursor)
  return output
}

const IMPORTED_NATIVE_DESKTOP_VARIANT_TOKENS = new Set([
  'computer',
  'computadora',
  'desktop',
  'escritorio',
  'laptop',
  'pc'
])

const IMPORTED_NATIVE_MOBILE_VARIANT_TOKENS = new Set([
  'cel',
  'celular',
  'mobile',
  'movil',
  'phone',
  'smartphone'
])

function normalizeImportedNativeVariantToken(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

export function getImportedNativeResponsiveVariant(value = '') {
  const tokens = normalizeImportedNativeVariantToken(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let device = ''
  const familyTokens = tokens.filter(token => {
    if (IMPORTED_NATIVE_DESKTOP_VARIANT_TOKENS.has(token)) {
      device = device && device !== 'desktop' ? 'mixed' : 'desktop'
      return false
    }
    if (IMPORTED_NATIVE_MOBILE_VARIANT_TOKENS.has(token)) {
      device = device && device !== 'mobile' ? 'mixed' : 'mobile'
      return false
    }
    return true
  })
  return {
    device: device === 'desktop' || device === 'mobile' ? device : '',
    family: familyTokens.join('-')
  }
}

export function areImportedNativeResponsiveVariants(first = '', second = '') {
  const left = getImportedNativeResponsiveVariant(first)
  const right = getImportedNativeResponsiveVariant(second)
  return Boolean(
    left.device &&
    right.device &&
    left.device !== right.device &&
    left.family &&
    left.family === right.family
  )
}

export function resolveVisibleImportedNativeElementSelection({
  slots = [],
  currentKey = '',
  visibleKeys = []
} = {}) {
  if (!currentKey) return ''
  const visible = new Set(visibleKeys)
  if (visible.has(currentKey)) return currentKey
  const current = slots.find(slot => slot?.key === currentKey)
  if (!current) return ''
  const sameTypeVisible = slots.filter(slot => slot?.type === current.type && visible.has(slot.key))
  const responsiveVisible = sameTypeVisible.filter(slot => (
    areImportedNativeResponsiveVariants(current.id, slot?.id)
  ))
  if (responsiveVisible.length === 1) return responsiveVisible[0].key
  return sameTypeVisible.length === 1 ? sameTypeVisible[0].key : ''
}
