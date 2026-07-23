export const IMPORTED_HTML_MOBILE_BREAKPOINT_PX = 640
export const IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX = 390
export const IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE = 'data-rstk-device-only'
export const DEFAULT_IMPORTED_HTML_FAVICON_TAG = '<link rel="icon" type="image/svg+xml" data-rstk-default-favicon="true" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2216%22%20fill%3D%22%23111827%22%2F%3E%3Cpath%20d%3D%22M32%209l6.2%2016.8L55%2032l-16.8%206.2L32%2055l-6.2-16.8L9%2032l16.8-6.2L32%209z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E">'

export const IMPORTED_HTML_FAVICON_RULES = Object.freeze([
  'REQUISITO OBLIGATORIO DE ENTREGA: cada documento HTML debe incluir dentro de <head> un <link rel="icon" href="..."> válido. No termines ni respondas status="ready" hasta comprobarlo.',
  'El favicon debe representar la marca o el concepto del sitio y cargar de verdad en la pestaña. Para un HTML único usa un data:image/svg+xml autocontenido; para un ZIP puedes incluir favicon.svg, favicon.png o favicon.ico y referenciar ese archivo. También puedes usar una URL HTTPS si el usuario la proporcionó expresamente.',
  'No uses href vacío, #, javascript:, una ruta a un archivo inexistente ni el favicon de la aplicación Ristak como sustituto de la identidad del sitio.',
  'En sitios multipágina usa el mismo favicon en todas las páginas. Al editar conserva el favicon existente salvo que el usuario pida reemplazarlo; si falta, agrégalo antes de entregar.'
])

export function buildImportedHtmlFaviconRulesText(heading = 'Favicon obligatorio:') {
  return [heading, ...IMPORTED_HTML_FAVICON_RULES.map(rule => `- ${rule}`)].join('\n')
}

export function importedHtmlHasFavicon(html = '') {
  const linkPattern = /<link\b([^>]*)>/gi
  let match
  while ((match = linkPattern.exec(String(html || '')))) {
    const attrs = match[1] || ''
    const relMatch = attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
    const rel = String(relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? '').trim().toLowerCase()
    if (!rel.split(/\s+/).includes('icon')) continue

    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
    const href = String(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '').trim()
    if (href && href !== '#' && !/^javascript:/i.test(href)) return true
  }
  return false
}

export function ensureImportedHtmlFavicon(html = '') {
  const source = String(html || '')
  if (importedHtmlHasFavicon(source)) return source
  if (/<\/head>/i.test(source)) {
    return source.replace(/<\/head>/i, `${DEFAULT_IMPORTED_HTML_FAVICON_TAG}\n</head>`)
  }
  if (/<body\b/i.test(source)) {
    return source.replace(/<body\b/i, `<head>\n${DEFAULT_IMPORTED_HTML_FAVICON_TAG}\n</head>\n$&`)
  }
  return `${DEFAULT_IMPORTED_HTML_FAVICON_TAG}\n${source}`
}

export function buildImportedHtmlDeviceVisibilityStyle(previewDevice = '') {
  const device = String(previewDevice || '').trim().toLowerCase()
  const selector = `[${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE}`
  const css = device === 'desktop'
    ? `${selector}="mobile"]{display:none!important}`
    : device === 'mobile'
      ? `${selector}="desktop"]{display:none!important}`
      : `@media (min-width:${IMPORTED_HTML_MOBILE_BREAKPOINT_PX + 1}px){${selector}="mobile"]{display:none!important}}\n@media (max-width:${IMPORTED_HTML_MOBILE_BREAKPOINT_PX}px){${selector}="desktop"]{display:none!important}}`

  return `<style data-rstk-device-visibility="${device || 'responsive'}">${css}</style>`
}

export const IMPORTED_HTML_MOBILE_RULES = Object.freeze([
  'Incluye <meta name="viewport" content="width=device-width, initial-scale=1"> en cada documento HTML.',
  `Diseña una versión móvil real y fluida. Incluye reglas @media (max-width: ${IMPORTED_HTML_MOBILE_BREAKPOINT_PX}px) con cambios concretos; no basta con reducir visualmente la versión de escritorio.`,
  `Visibilidad por dispositivo: si un elemento debe existir solo en computadora, marca su contenedor completo con ${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE}="desktop". Si debe existir solo en celular, usa ${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE}="mobile". Un elemento compartido por ambas vistas no lleva ese atributo.`,
  `Cuando computadora y celular necesiten composiciones distintas, crea dos contenedores hermanos —uno ${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE}="desktop" y otro ${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE}="mobile"—. No uses JavaScript, clases inventadas ni hidden para alternarlos y no repitas el atributo en cada hijo: Ristak oculta la variante contraria en el selector del editor y en el sitio publicado.`,
  `Valida el resultado en un viewport de ${IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX}px: no debe existir scroll horizontal, contenido cortado ni texto, botones, formularios, imágenes, videos o iframes fuera del ancho visible.`,
  'En móvil convierte grids y filas de varias columnas a una sola columna cuando sea necesario, conserva el orden lógico del contenido y usa padding lateral seguro.',
  'Usa anchos fluidos (width: 100% y max-width), min-width: 0 y box-sizing: border-box. Evita anchos fijos, min-width de escritorio y 100vw dentro de contenedores con padding.',
  'Imágenes, video, audio e iframes deben respetar max-width: 100%; las imágenes y videos conservan su proporción con height: auto o aspect-ratio.',
  `Si necesitas archivos de video distintos para computadora y móvil, declara dos slots nativos con la misma base semántica y sufijos claros, por ejemplo video-presentacion-desktop y video-presentacion-mobile. Envuelve cada slot en su contenedor ${IMPORTED_HTML_DEVICE_ONLY_ATTRIBUTE} correspondiente; Ristak enlaza el panel con la variante visible y usa la configurada como respaldo mientras la otra siga pendiente.`,
  'Controles táctiles deben medir al menos 44px de alto. En móvil, inputs, selects y textareas usan font-size de al menos 16px para evitar zoom automático del navegador.',
  'No simules móvil con zoom, transform: scale ni una captura encogida. El CSS responsive debe reaccionar al ancho real del viewport.',
  'Cuando edites una página existente, conserva sus media queries y vuelve a revisar escritorio y móvil. Un cambio de escritorio no puede romper la versión móvil ni viceversa.'
])

export const IMPORTED_HTML_CUSTOM_CALENDAR_RULES = Object.freeze([
  'El calendario custom debe ser una experiencia completa tipo Calendly, no un input de fecha aislado ni un select permanente de horarios.',
  'Usa un único contenedor raíz con data-rstk-native-element="calendar", data-rstk-native-id estable y data-rstk-native-render="custom". El HTML y el CSS controlan por completo el diseño; Ristak controla el mes vigente, disponibilidad real, zona horaria, selección y reserva.',
  'Clasifica el elemento por la operación real que confirma su único submit, nunca por el orden visual, la cantidad de preguntas ni el nombre del evento Meta. Si ese submit crea la cita, TODO el recorrido es un elemento calendar aunque muestre preguntas antes, después o entre fecha y horario. Ristak lo detecta solo como calendario; en Ajustes el usuario elige por separado qué evento Meta enviar al agendar.',
  'Si un formulario se envía y guarda antes o después como una operación independiente de la reserva, entonces sí son dos elementos: form y calendar, cada uno con su propio disparador y evento configurable. Avanzar entre pantallas sin enviar no crea otro elemento ni dispara conversiones.',
  'Nunca anides <form>. Para un flujo combinado cuyo submit crea la cita, el único <form data-rstk-calendar-book-form> envuelve todas las preguntas y pasos, sin data-rstk-form-id ni submit intermedio. Los botones para avanzar o regresar usan type="button"; solo el botón que finalmente confirma la cita usa type="submit".',
  'Para ordenar libremente el recorrido usa secciones data-rstk-calendar-flow-step="id-estable" con data-rstk-calendar-flow-kind="questions|date|time|confirm|success". El orden del DOM manda: puedes construir preguntas → fecha → horario → confirmar, fecha → horario → preguntas → confirmar o intercalar preguntas. En questions usa data-rstk-calendar-flow-next y data-rstk-calendar-flow-back; Ristak valida los campos required sin enviar todavía nada.',
  'Si la solicitud dice que el formulario pertenece al calendario, que debe aparecer después de agendar o que primero se eligen fecha y hora, el orden obligatorio es date → time → questions → confirm → success. No muestres situación, inversión, contacto ni ningún otro campo antes de seleccionar un horario; los datos de contacto van en el último paso questions, justo antes de confirm.',
  'Si el calendario se desbloquea al avanzar un video, usa el contrato nativo data-rstk-video-gate-* descrito más abajo. El estado inicial recomendado usa un solo calendario real, visible con blur pero inert e imposible de tocar, y una capa encima con el progreso restante; declara data-rstk-video-gate-shell y data-rstk-video-gate-locked-mode="blur". No dibujes otro calendario bloqueado ni uses reglas individuales para simular cada segundo. Al desbloquear, empieza en date: las preguntas siguen ocultas hasta que el visitante seleccione time.',
  'Nombre, email y teléfono pueden aparecer en cualquier paso questions dentro del mismo data-rstk-calendar-book-form; conserva data-rstk-calendar-name, data-rstk-calendar-email y data-rstk-calendar-phone. No los repitas al final: Ristak conserva sus valores y los usa cuando el submit crea la cita.',
  'Las demás respuestas que deban acompañar la cita usan data-rstk-calendar-response="id-estable" y data-rstk-label="Pregunta visible". Ristak las manda con la reserva y las agrega al resumen de la cita; no inventes un segundo submit para guardarlas.',
  'Construye cuatro pasos dentro del mismo componente: data-rstk-calendar-step="date", "time", "form" y "success". Deja time, form y success con hidden al cargar; Ristak cambia el paso y el atributo data-rstk-calendar-state del contenedor.',
  'En date incluye navegación mensual con data-rstk-calendar-prev-month, data-rstk-calendar-month-label y data-rstk-calendar-next-month; muestra encabezados visibles de domingo a sábado y deja un contenedor vacío data-rstk-calendar-days con layout CSS de 7 columnas.',
  'Ristak llena data-rstk-calendar-days con todos los días del mes. El CSS debe contemplar [data-rstk-calendar-day][data-state="available"], [data-state="unavailable"], [data-state="outside"] y [data-selected="true"]. Los días sin disponibilidad llegan deshabilitados; no hardcodees fechas ni decidas disponibilidad en HTML.',
  'En time incluye data-rstk-calendar-selected-date, data-rstk-calendar-back-to-dates y un contenedor vacío data-rstk-calendar-slots. Ristak genera un botón por horario real con data-rstk-calendar-slot y data-selected="true|false"; estiliza esos selectores para que los horarios se elijan como botones, no como un simple select.',
  'En el flujo normal, form incluye data-rstk-calendar-selected-datetime, data-rstk-calendar-back-to-times y un <form data-rstk-calendar-book-form>. Nombre, email y teléfono usan respectivamente data-rstk-calendar-name, data-rstk-calendar-email y data-rstk-calendar-phone; data-rstk-calendar-notes es opcional. En el flujo compuesto, ese único form ya envuelve todo y el paso form contiene únicamente el resumen y el botón submit final.',
  'Ese <form> pertenece al calendario y NO es un formulario independiente de captación. No le agregues data-rstk-form-id, data-rstk-field-id, data-rstk-conversion-event ni data-rstk-conversion-type: Ristak toma esos datos para reservar y, después de confirmar la cita real, emite únicamente el evento que el usuario configuró para ese elemento calendar en Ajustes (Schedule es solo el default recomendado).',
  'En success incluye un elemento data-rstk-calendar-success. Fuera o dentro de los pasos agrega data-rstk-calendar-message con role="status" para carga, falta de cupo y errores.',
  'Puedes mostrar la zona activa con data-rstk-calendar-timezone-label. Si agregas un select data-rstk-calendar-timezone, sus opciones deben ser zonas IANA válidas; Ristak vuelve a agrupar los instantes al cambiarla.',
  'No agregues JavaScript de calendario, fetch, fechas, slots ni submit. Ristak consulta el calendario asociado, agrupa los instantes UTC para la zona mostrada, Ristak vuelve a validar el horario al reservar y ejecuta la acción posterior configurada.',
  'En vista previa Ristak muestra disponibilidad real, pero el envío es de demostración: no crea la cita, no redirige y no dispara Pixel/CAPI.',
  'El grid, los horarios y el formulario deben ser responsive: sin scroll horizontal a 390px, controles táctiles de al menos 44px y una jerarquía clara entre elegir fecha, elegir hora y completar datos.'
])

export const IMPORTED_HTML_COMPOSITE_CALENDAR_SKELETON = `<section data-rstk-native-element="calendar" data-rstk-native-id="agenda-compuesta" data-rstk-native-render="custom" data-rstk-label="Solicitud y agenda">
  <form data-rstk-calendar-book-form>
    <section data-rstk-calendar-flow-step="fecha" data-rstk-calendar-flow-kind="date">
      <header><button type="button" data-rstk-calendar-prev-month aria-label="Mes anterior">‹</button><strong data-rstk-calendar-month-label></strong><button type="button" data-rstk-calendar-next-month aria-label="Mes siguiente">›</button></header>
      <div data-rstk-calendar-weekdays aria-hidden="true"><span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span></div>
      <div data-rstk-calendar-days></div>
    </section>
    <section data-rstk-calendar-flow-step="horario" data-rstk-calendar-flow-kind="time" hidden><button type="button" data-rstk-calendar-flow-back>Cambiar fecha</button><h3 data-rstk-calendar-selected-date></h3><div data-rstk-calendar-slots></div></section>
    <section data-rstk-calendar-flow-step="contacto" data-rstk-calendar-flow-kind="questions" hidden>
      <label>Nombre<input name="name" autocomplete="name" data-rstk-calendar-name data-rstk-calendar-response="nombre" data-rstk-label="Nombre" required></label>
      <label>Correo<input type="email" name="email" autocomplete="email" data-rstk-calendar-email data-rstk-calendar-response="correo" data-rstk-label="Correo" required></label>
      <button type="button" data-rstk-calendar-flow-back>Regresar</button><button type="button" data-rstk-calendar-flow-next>Siguiente</button>
    </section>
    <section data-rstk-calendar-flow-step="calificacion" data-rstk-calendar-flow-kind="questions" hidden>
      <label>¿Qué necesitas?<textarea name="necesidad" data-rstk-calendar-response="necesidad" data-rstk-label="Qué necesita" required></textarea></label>
      <button type="button" data-rstk-calendar-flow-back>Anterior</button><button type="button" data-rstk-calendar-flow-next>Revisar cita</button>
    </section>
    <section data-rstk-calendar-flow-step="confirmar" data-rstk-calendar-flow-kind="confirm" hidden><button type="button" data-rstk-calendar-flow-back>Cambiar datos</button><p data-rstk-calendar-selected-datetime></p><button type="submit">Confirmar cita</button></section>
    <section data-rstk-calendar-flow-step="listo" data-rstk-calendar-flow-kind="success" hidden><p data-rstk-calendar-success></p></section>
  </form>
  <p data-rstk-calendar-message role="status" aria-live="polite"></p>
</section>`

export const IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON = `<section data-rstk-native-element="calendar" data-rstk-native-id="agenda-custom" data-rstk-native-render="custom" data-rstk-label="Agenda principal">
  <section data-rstk-calendar-step="date">
    <header><button type="button" data-rstk-calendar-prev-month aria-label="Mes anterior">‹</button><strong data-rstk-calendar-month-label></strong><button type="button" data-rstk-calendar-next-month aria-label="Mes siguiente">›</button></header>
    <div data-rstk-calendar-weekdays aria-hidden="true"><span>Dom</span><span>Lun</span><span>Mar</span><span>Mié</span><span>Jue</span><span>Vie</span><span>Sáb</span></div>
    <div data-rstk-calendar-days></div>
  </section>
  <section data-rstk-calendar-step="time" hidden><button type="button" data-rstk-calendar-back-to-dates>Cambiar fecha</button><h3 data-rstk-calendar-selected-date></h3><div data-rstk-calendar-slots></div></section>
  <section data-rstk-calendar-step="form" hidden><button type="button" data-rstk-calendar-back-to-times>Cambiar horario</button><p data-rstk-calendar-selected-datetime></p><form data-rstk-calendar-book-form><label>Nombre<input name="name" autocomplete="name" data-rstk-calendar-name required></label><label>Correo<input type="email" name="email" autocomplete="email" data-rstk-calendar-email required></label><label>Teléfono<input type="tel" name="phone" autocomplete="tel" data-rstk-calendar-phone required></label><button type="submit">Confirmar cita</button></form></section>
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
    IMPORTED_HTML_CUSTOM_CALENDAR_SKELETON,
    '- Si el usuario combina preguntas y agenda bajo un único submit que crea la cita, usa esta variante flexible y reordena sus flow-step según la experiencia pedida:',
    IMPORTED_HTML_COMPOSITE_CALENDAR_SKELETON
  ].join('\n')
}

export const IMPORTED_HTML_CUSTOM_SOCIAL_PROFILE_RULES = Object.freeze([
  'Diseño por defecto: si el usuario pide mostrar un perfil conectado pero NO describe otra composición visual, no lo recrees como HTML custom. Usa un slot vacío <div data-rstk-native-element="social-profile" data-rstk-native-id="perfil-principal" data-rstk-native-render="ristak" data-rstk-label="Perfil principal"></div>. Así Ristak monta exactamente el mismo perfil social del editor normal.',
  'El slot nativo data-rstk-native-render="ristak" también debe conservar altura intrínseca: no le pongas height, min-height, max-height, block-size, unidades vh/svh/dvh, aspect-ratio, flex: 1, flex-grow ni estiramiento de grid. No reserves una pantalla para el slot; ubícalo en el flujo normal y deja que el contenido siguiente comience inmediatamente después.',
  'La referencia canónica de Ristak es una fila compacta y transparente: avatar circular a la izquierda, insignia de la red superpuesta en la esquina inferior derecha del avatar, nombre a la derecha con la roseta azul exacta de cuenta verificada alineada junto al texto y seguidores debajo. No la conviertas por defecto en una tarjeta, un hero ni un bloque de ancho o alto completo.',
  'Usa data-rstk-native-render="custom" únicamente cuando el usuario pida de forma explícita otro diseño o una composición diferente. Ese diseño alternativo puede ser completamente libre; Ristak seguirá aportando foto, nombre, seguidores, plataforma y estado verificado mediante los hooks.',
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

export const IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE = 'data-rstk-video-settings'

const IMPORTED_HTML_VIDEO_PLAYER_BOOLEAN_KEYS = new Set([
  'videoOverlayPlay',
  'videoControlBar',
  'videoControlBarInitiallyVisible',
  'videoControlPlay',
  'videoControlProgress',
  'videoControlVolume',
  'videoControlSpeed',
  'videoControlSettings',
  'videoControlTime',
  'videoTrickProgressEnabled',
  'videoPreviewEnabled',
  'videoDisableEditorPlayback',
  'videoSoundHint',
  'videoMuted',
  'videoAutoplay',
  'videoLoop'
])

const IMPORTED_HTML_VIDEO_PLAYER_ENUM_KEYS = Object.freeze({
  videoControlsMode: new Set(['clean', 'native', 'none']),
  videoOrientation: new Set(['auto', 'landscape', 'portrait']),
  videoPortraitWidthMode: new Set(['auto', 'fill', 'framed']),
  videoFit: new Set(['cover', 'contain', 'fill']),
  videoPlayShape: new Set(['round', 'rectangle']),
  videoPlayIconStyle: new Set(['solid', 'outline', 'soft', 'spark']),
  mediaAlign: new Set(['left', 'center', 'right'])
})

const IMPORTED_HTML_VIDEO_PLAYER_NUMBER_RANGES = Object.freeze({
  videoControlPanelRadius: [0, 48],
  videoTrickProgressRampPercent: [5, 85],
  videoTrickProgressPeakPercent: [55, 96],
  videoPreviewStart: [0, 86400],
  videoPreviewEnd: [0, 86400],
  videoSoundNoticeHideAfter: [0, 12],
  videoDefaultSpeed: [0.25, 4],
  videoPlayerRadius: [0, 80],
  videoPlayerBorderWidth: [0, 12],
  videoPlaySize: [56, 160],
  videoPlayRadius: [0, 999],
  videoPlayIconSize: [18, 95],
  mediaWidth: [30, 100]
})

const IMPORTED_HTML_VIDEO_PLAYER_PAINT_KEYS = new Set([
  'videoPlayerBackground',
  'videoPlayerBorderColor',
  'videoPlayerColor',
  'videoPlayColor',
  'videoSoundColor'
])

const IMPORTED_HTML_VIDEO_PLAYER_STRING_KEYS = Object.freeze({
  mediaUrl: 4000,
  videoSoundNoticeText: 180
})

export const IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEYS = Object.freeze([
  ...IMPORTED_HTML_VIDEO_PLAYER_BOOLEAN_KEYS,
  ...Object.keys(IMPORTED_HTML_VIDEO_PLAYER_ENUM_KEYS),
  ...Object.keys(IMPORTED_HTML_VIDEO_PLAYER_NUMBER_RANGES),
  ...IMPORTED_HTML_VIDEO_PLAYER_PAINT_KEYS,
  ...Object.keys(IMPORTED_HTML_VIDEO_PLAYER_STRING_KEYS),
  'responsive'
])

const IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEY_SET = new Set(IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEYS)

function importedHtmlVideoPlayerError(message = '') {
  return { valid: false, settings: {}, tombstones: [], error: message }
}

function normalizeImportedHtmlVideoPlayerNumber(value, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, number))
}

function normalizeImportedHtmlVideoPlayerResponsive(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, value: null, error: 'responsive debe ser un objeto con tablet y/o mobile.' }
  }
  const devices = Object.keys(value)
  if (devices.some(device => !['tablet', 'mobile'].includes(device))) {
    return { valid: false, value: null, error: 'responsive solo admite tablet y mobile.' }
  }
  const normalized = {}
  for (const device of devices) {
    const source = value[device]
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return { valid: false, value: null, error: `responsive.${device} debe ser un objeto.` }
    }
    const keys = Object.keys(source)
    if (keys.some(key => !['mediaWidth', 'mediaAlign'].includes(key))) {
      return { valid: false, value: null, error: `responsive.${device} solo admite mediaWidth y mediaAlign.` }
    }
    const entry = {}
    if (Object.prototype.hasOwnProperty.call(source, 'mediaWidth')) {
      const mediaWidth = normalizeImportedHtmlVideoPlayerNumber(source.mediaWidth, 30, 100)
      if (mediaWidth === null) {
        return { valid: false, value: null, error: `responsive.${device}.mediaWidth debe ser un número entre 30 y 100.` }
      }
      entry.mediaWidth = mediaWidth
    }
    if (Object.prototype.hasOwnProperty.call(source, 'mediaAlign')) {
      const mediaAlign = String(source.mediaAlign || '').trim()
      if (!IMPORTED_HTML_VIDEO_PLAYER_ENUM_KEYS.mediaAlign.has(mediaAlign)) {
        return { valid: false, value: null, error: `responsive.${device}.mediaAlign debe ser left, center o right.` }
      }
      entry.mediaAlign = mediaAlign
    }
    normalized[device] = entry
  }
  return { valid: true, value: normalized, error: '' }
}

/**
 * Valida y normaliza la configuración declarativa del reproductor nativo de
 * video dentro de HTML importado. Un `null` explícito es un tombstone: quita
 * esa propiedad declarativa sin adueñarse del resto de los ajustes del bloque.
 */
export function normalizeImportedHtmlVideoPlayerManifest(value = '') {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (String(raw || '').length > 24576) {
    return importedHtmlVideoPlayerError(`${IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE} supera el máximo de 24 KB.`)
  }

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return importedHtmlVideoPlayerError(`${IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE} no contiene JSON válido.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return importedHtmlVideoPlayerError(`${IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE} debe contener un objeto JSON.`)
  }

  const keys = Object.keys(parsed)
  if (keys.length > IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEYS.length) {
    return importedHtmlVideoPlayerError(`${IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE} contiene demasiadas propiedades.`)
  }
  const unknownKey = keys.find(key => !IMPORTED_HTML_VIDEO_PLAYER_SETTING_KEY_SET.has(key))
  if (unknownKey) {
    return importedHtmlVideoPlayerError(`La propiedad ${unknownKey} no existe en el reproductor de Ristak.`)
  }

  const settings = {}
  const tombstones = []
  for (const key of keys) {
    const source = parsed[key]
    if (source === null) {
      tombstones.push(key)
      continue
    }
    if (IMPORTED_HTML_VIDEO_PLAYER_BOOLEAN_KEYS.has(key)) {
      if (typeof source !== 'boolean') {
        return importedHtmlVideoPlayerError(`${key} debe ser true o false.`)
      }
      settings[key] = source
      continue
    }
    if (Object.prototype.hasOwnProperty.call(IMPORTED_HTML_VIDEO_PLAYER_ENUM_KEYS, key)) {
      const normalized = String(source || '').trim()
      if (!IMPORTED_HTML_VIDEO_PLAYER_ENUM_KEYS[key].has(normalized)) {
        return importedHtmlVideoPlayerError(`${key} contiene un valor no permitido.`)
      }
      settings[key] = normalized
      continue
    }
    if (Object.prototype.hasOwnProperty.call(IMPORTED_HTML_VIDEO_PLAYER_NUMBER_RANGES, key)) {
      const [min, max] = IMPORTED_HTML_VIDEO_PLAYER_NUMBER_RANGES[key]
      const normalized = normalizeImportedHtmlVideoPlayerNumber(source, min, max)
      if (normalized === null) {
        return importedHtmlVideoPlayerError(`${key} debe ser un número entre ${min} y ${max}.`)
      }
      settings[key] = normalized
      continue
    }
    if (IMPORTED_HTML_VIDEO_PLAYER_PAINT_KEYS.has(key)) {
      const normalized = typeof source === 'string' ? source.trim() : ''
      if (!normalized || normalized.length > 256) {
        return importedHtmlVideoPlayerError(`${key} debe ser un color o degradado CSS válido de máximo 256 caracteres.`)
      }
      settings[key] = normalized
      continue
    }
    if (Object.prototype.hasOwnProperty.call(IMPORTED_HTML_VIDEO_PLAYER_STRING_KEYS, key)) {
      const normalized = typeof source === 'string' ? source.trim() : ''
      const maxLength = IMPORTED_HTML_VIDEO_PLAYER_STRING_KEYS[key]
      if (normalized.length > maxLength) {
        return importedHtmlVideoPlayerError(`${key} supera el máximo de ${maxLength} caracteres.`)
      }
      settings[key] = normalized
      continue
    }
    if (key === 'responsive') {
      const normalized = normalizeImportedHtmlVideoPlayerResponsive(source)
      if (!normalized.valid) return importedHtmlVideoPlayerError(normalized.error)
      settings.responsive = normalized.value
    }
  }

  // Los navegadores bloquean autoplay con audio. Igual que el panel normal,
  // el contrato declara la combinación funcional en vez de guardar un estado
  // que luego parece roto en publicado.
  if (settings.videoAutoplay === true) settings.videoMuted = true

  return { valid: true, settings, tombstones, error: '' }
}

export const IMPORTED_HTML_VIDEO_PLAYER_RULES = Object.freeze([
  `En el mismo slot nativo de video puedes declarar ${IMPORTED_HTML_VIDEO_PLAYER_SETTINGS_ATTRIBUTE} como un objeto JSON. Ristak aplica exactamente el mismo reproductor y las mismas opciones del editor normal; no dibujes controles HTML ni escribas JavaScript propio.`,
  'Visibilidad total: videoControlsMode acepta clean, native o none. En clean controla por separado videoOverlayPlay, videoControlBar, videoControlBarInitiallyVisible, videoControlPlay, videoControlProgress, videoControlTime, videoControlVolume, videoControlSpeed y videoControlSettings.',
  'Diseño total: configura videoPlayerBackground, videoPlayerRadius, videoPlayerBorderColor, videoPlayerBorderWidth, videoPlayerColor, videoPlayColor, videoPlaySize, videoPlayShape (round|rectangle), videoPlayRadius, videoPlayIconStyle (solid|outline|soft|spark), videoPlayIconSize, videoSoundColor y videoControlPanelRadius.',
  'Reproducción total: configura videoMuted, videoAutoplay, videoLoop, videoDefaultSpeed, videoPreviewEnabled, videoPreviewStart, videoPreviewEnd, videoDisableEditorPlayback, videoSoundHint, videoSoundNoticeText, videoSoundNoticeHideAfter, videoTrickProgressEnabled, videoTrickProgressRampPercent y videoTrickProgressPeakPercent. Autoplay siempre se normaliza a silenciado porque así lo exigen los navegadores.',
  'Formato y tamaño: configura videoOrientation (auto|landscape|portrait), videoPortraitWidthMode (auto|fill|framed), videoFit (cover|contain|fill), mediaWidth, mediaAlign y responsive con overrides tablet/mobile de mediaWidth y mediaAlign. El slot sigue sin llevar geometría CSS propia.',
  'Conserva el atributo y sus claves al editar otras partes del HTML. La primera declaración completa ajustes faltantes; después Ristak solo aplica las propiedades cuyo valor declarativo cambió, de modo que no pisa personalizaciones manuales del panel.',
  'Quitar el atributo o quitar una clave del JSON no borra nada. Para dejar de declarar y restablecer una propiedad concreta, envíala una vez con null; por ejemplo {"videoControlVolume":null}. Las claves desconocidas o valores inválidos bloquean Guardar/Publicar para evitar un reproductor a medias.',
  'data-rstk-video-settings controla el reproductor; data-rstk-video-rules controla las acciones. Ambos viven en el mismo slot, usan el mismo data-rstk-native-id estable y pueden combinarse.'
])

export const IMPORTED_HTML_VIDEO_PLAYER_EXAMPLE = `<div
  data-rstk-native-element="video"
  data-rstk-native-id="video-principal"
  data-rstk-label="Video principal"
  data-rstk-video-settings='{"videoControlsMode":"clean","videoOverlayPlay":true,"videoControlBar":true,"videoControlBarInitiallyVisible":true,"videoControlPlay":true,"videoControlProgress":true,"videoControlTime":true,"videoControlVolume":true,"videoControlSpeed":true,"videoControlSettings":true,"videoPlayerColor":"rgba(0,0,0,.62)","videoPlayColor":"#ffffff","videoPlayShape":"round","videoPlaySize":96,"videoPlayIconStyle":"solid","videoPlayIconSize":44,"videoControlPanelRadius":22,"videoMuted":true,"videoAutoplay":false,"videoLoop":false,"videoDefaultSpeed":1,"videoSoundHint":true,"videoOrientation":"auto","videoFit":"cover","videoPortraitWidthMode":"auto","responsive":{"mobile":{"mediaWidth":100,"mediaAlign":"center"}}}'
></div>`

export function buildImportedHtmlVideoPlayerRulesText(heading = 'Reproductor de video HTML con control total:') {
  return [
    heading,
    ...IMPORTED_HTML_VIDEO_PLAYER_RULES.map(rule => `- ${rule}`),
    '- Ejemplo completo:',
    IMPORTED_HTML_VIDEO_PLAYER_EXAMPLE
  ].join('\n')
}

export const IMPORTED_HTML_VIDEO_GATE_RULES = Object.freeze([
  'Para bloquear de verdad un calendario, formulario, checkout o sección hasta que se vea un video, declara data-rstk-video-gate-id="id-estable" en el slot nativo de video y data-rstk-video-gate-value con el umbral. Ristak mide el reproductor real; no escribas JavaScript ni una regla por cada segundo.',
  'data-rstk-video-gate-trigger acepta playback_seconds, unique_watched_percent o timeline_reached. Usa playback_seconds cuando adelantar o mover la barra NO debe contar: seek, buffering y el preview automático no cuentan. Usa unique_watched_percent cuando el umbral sea un porcentaje de fragmentos realmente vistos; timeline_reached sí acepta que el visitante adelante.',
  'La sesión abierta con Previsualizar sí es interactiva: después de que la persona pulsa play, Ristak debe descontar el tiempo y ejecutar las mismas reglas que en publicado. Sólo el loop automático decorativo anterior al primer play queda excluido.',
  'El reproductor nativo publica un único estado real para currentTime, duration, timelinePercent, playbackSeconds y uniqueWatchedPercent. Los gates y data-rstk-video-rules consumen ese mismo estado; el HTML no debe crear setInterval, cronómetros propios ni intentar leer directamente Bunny.',
  'Marca el diseño que debe verse mientras está bloqueado con data-rstk-video-gate-locked="id-estable", el número vivo con data-rstk-video-gate-remaining="id-estable" y envuelve TODO el contenido real con data-rstk-video-gate-content="id-estable". Por default Ristak oculta e inutiliza ese contenido desde el primer render y lo muestra únicamente al llegar al umbral.',
  'Para que el calendario real permanezca visible pero desenfocado, usa un único contenedor data-rstk-video-gate-shell="id-estable". Dentro coloca como hijos directos el calendario real con data-rstk-video-gate-content y data-rstk-video-gate-locked-mode="blur", y la capa de texto con data-rstk-video-gate-locked. Ristak pone la capa encima del mismo calendario, conserva el contenido visible con blur, lo vuelve inert e imposible de tocar y quita blur y capa al desbloquear.',
  'En modo blur NO dibujes un calendario bloqueado falso y otro calendario real debajo. Existe un solo calendario real detrás de la capa; el HTML/CSS puede ajustar la intensidad con --rstk-video-gate-blur y la opacidad con --rstk-video-gate-locked-opacity.',
  'Si el contenido es un calendario compuesto, mientras siga bloqueado Ristak muestra juntos date y time usando el primer día con disponibilidad real del mes para enseñar horas reales detrás del blur. Questions, contacto, confirm y success permanecen ocultos. Al desbloquear se limpia esa preselección y el visitante empieza en date para elegir su propia fecha.',
  'El contenido real incluye el slot nativo completo. Si es un calendario compuesto, data-rstk-video-gate-content envuelve fecha, horario, preguntas, contacto, confirmación y éxito; nunca dejes el formulario o el calendario real como hermano visible fuera de esa zona.',
  'Para computadora y móvil con videos distintos, ambos slots usan el mismo data-rstk-video-gate-id, trigger y value. Ristak toma el mayor progreso real de las variantes y nunca suma dos reproducciones simultáneas.',
  'El elemento data-rstk-video-gate-remaining debe traer como texto inicial el umbral completo para que la página sea legible aun antes de iniciar el runtime. Ristak lo reemplaza por el restante real y lo deja en 0 al desbloquear.',
  'No combines este contrato con acciones show/hide que controlen el mismo estado bloqueado, contenido o contador. data-rstk-video-rules sigue disponible para otras acciones independientes del video.'
])

export const IMPORTED_HTML_VIDEO_GATE_EXAMPLE = `<div
  data-rstk-native-element="video"
  data-rstk-native-id="video-principal"
  data-rstk-label="Video principal"
  data-rstk-video-gate-id="agenda-admision"
  data-rstk-video-gate-trigger="playback_seconds"
  data-rstk-video-gate-value="30"
></div>

<section data-rstk-video-gate-shell="agenda-admision">
  <section
    data-rstk-native-element="calendar"
    data-rstk-native-id="agenda-real"
    data-rstk-native-render="custom"
    data-rstk-video-gate-content="agenda-admision"
    data-rstk-video-gate-locked-mode="blur"
  ></section>

  <section data-rstk-video-gate-locked="agenda-admision" role="status" aria-live="polite">
    <p>Tu solicitud de inscripción se habilitará al avanzar en este video.</p>
    <p>Faltan <strong data-rstk-video-gate-remaining="agenda-admision">30</strong> segundos de reproducción.</p>
  </section>
</section>`

export function buildImportedHtmlVideoGateRulesText(heading = 'Bloqueo nativo de contenido por video:') {
  return [
    heading,
    ...IMPORTED_HTML_VIDEO_GATE_RULES.map(rule => `- ${rule}`),
    '- Ejemplo mínimo:',
    IMPORTED_HTML_VIDEO_GATE_EXAMPLE
  ].join('\n')
}

export const IMPORTED_HTML_VIDEO_ACTION_TARGET_RULES = Object.freeze([
  'Prepara desde el inicio todos los elementos visibles que una acción de video podría controlar, aunque todavía no exista ninguna regla ni se haya elegido mostrar u ocultar algo en el editor.',
  'Cada CTA, botón, enlace, formulario, sección, bloque de texto, título, imagen, figura y slot nativo controlable debe tener un data-rstk-video-action-target semántico, estable y único en su página, además de data-rstk-label con un nombre humano reconocible en el panel.',
  'Conserva exactamente esos identificadores al cambiar copy, clases, estilos, posición o diseño responsive. No recicles un identificador para otro elemento y no uses índices visuales frágiles como boton-1 cuando exista un nombre de negocio como aplicar-ahora.',
  'Marca el elemento completo que debe aparecer, ocultarse, desplazarse o cambiar; no marques spans, iconos o wrappers internos si la acción debe controlar el botón, tarjeta o sección completa.',
  'Los interiores de form, calendar, payment, video o social-profile nativos pertenecen a Ristak: marca el slot raíz si debe ser controlable, pero no agregues targets a sus controles internos.',
  'data-rstk-video-rules referencia exclusivamente esos valores mediante targetBlockIds. No escribas JavaScript para ocultar, mostrar, medir progreso ni reaccionar al reproductor; Ristak aplica el estado inicial y ejecuta la acción en preview y publicado.',
  'Acciones disponibles: show, hide, open_form, open_video_form, show_popup, site_page, redirect, change_text, change_link, scroll_to, activate_checkout, meta_event y reveal_form_action. Usa las propiedades que correspondan: targetBlockIds, targetPageId, redirectUrl, value, before, pauseUntilComplete, metaCapiEnabled, metaEventName, metaEventParameters y repeatMode.'
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
