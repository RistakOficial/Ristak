export const IMPORTED_HTML_MOBILE_BREAKPOINT_PX = 640
export const IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX = 390

export const IMPORTED_HTML_MOBILE_RULES = Object.freeze([
  'Incluye <meta name="viewport" content="width=device-width, initial-scale=1"> en cada documento HTML.',
  `Diseña una versión móvil real y fluida. Incluye reglas @media (max-width: ${IMPORTED_HTML_MOBILE_BREAKPOINT_PX}px) con cambios concretos; no basta con reducir visualmente la versión de escritorio.`,
  `Valida el resultado en un viewport de ${IMPORTED_HTML_MOBILE_PREVIEW_WIDTH_PX}px: no debe existir scroll horizontal, contenido cortado ni texto, botones, formularios, imágenes, videos o iframes fuera del ancho visible.`,
  'En móvil convierte grids y filas de varias columnas a una sola columna cuando sea necesario, conserva el orden lógico del contenido y usa padding lateral seguro.',
  'Usa anchos fluidos (width: 100% y max-width), min-width: 0 y box-sizing: border-box. Evita anchos fijos, min-width de escritorio y 100vw dentro de contenedores con padding.',
  'Imágenes, video, audio e iframes deben respetar max-width: 100%; las imágenes y videos conservan su proporción con height: auto o aspect-ratio.',
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
