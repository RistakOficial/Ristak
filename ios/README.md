# Ristak iOS — App nativa universal (iPhone + iPad)

App nativa SwiftUI para operar el CRM Ristak desde iPhone y iPad. Usa el
backend existente (mismos endpoints, auth, permisos y reglas que el escritorio
y `/movil`), con navegación nativa de iOS 26 y Liquid Glass.

Esta es la unica ruta nativa Apple del repo. La carpeta `mobile/` queda
reservada para React Native/Expo Android y no debe recibir scripts, APNs,
entitlements, targets ni codigo nativo Apple.

- Proyecto: `ios/app/Ristak.xcodeproj` (target único `Ristak`)
- Bundle id: `com.ristak.app` (identidad oficial Apple/App Store; reemplaza el
  shell Capacitor legacy de tienda)
- Mínimo: iOS 26.0 · Xcode 26+ · Swift 5 mode · **cero dependencias externas**
- Universal: iPhone (tab bar compacta) + iPad (sidebar adaptable, split views,
  popovers), vertical y horizontal, claro/oscuro, Dynamic Type.
- Los globos siguen la apariencia elegida. En claro, los recibidos son blancos y
  los enviados conservan el pastel del canal; en oscuro, los recibidos usan
  carbón y los enviados tonos profundos de WhatsApp, Messenger o Instagram, con
  texto y metadatos claros. Correo/SMS permanecen neutrales en ambos temas.
- La bandeja de Chats abre desde el tope nativo con `Buscar chats` visible; el
  modo automatico de Apple no debe arrancar el campo colapsado como si el usuario
  ya hubiera desplazado la lista.
- Icono del launcher: `ios/app/Ristak/Assets.xcassets/AppIcon.appiconset`
  contiene las variantes oficiales `icon-light.png`, `icon-dark.png` e
  `icon-tinted.png` en 1024x1024 RGB sin transparencia para validacion iOS.

## Cómo correr

### Con Xcode
1. Abrir `ios/app/Ristak.xcodeproj`.
2. Elegir el destino (dispositivo físico o simulador iOS 26+) y ▶︎ Run.
   La firma es automática (equipo ya configurado en el proyecto).

### Por línea de comandos (dispositivo físico)
```bash
xcodebuild -project ios/app/Ristak.xcodeproj -scheme Ristak \
  -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates build
xcrun devicectl device install app --device <UDID> \
  <DerivedData>/Build/Products/Debug-iphoneos/Ristak.app
xcrun devicectl device process launch --device <UDID> com.ristak.app
```

### Login
- **Cuenta Ristak**: correo + contraseña de la cuenta. El correo resuelve el
  tenant automáticamente vía `POST https://www.ristak.com/api/mobile/resolve`
  y la app queda apuntando al servidor de esa instalación.
- El login nativo no expone configuración avanzada ni campo manual de servidor:
  la detección de cuenta por correo es el único flujo visible para usuarios.
- La cabecera muestra el isotipo libre, sin fondo, borde, sombra ni contenedor,
  y usa el wordmark oficial negro/blanco según el modo de apariencia. La pantalla
  no explica la resolución automática ni muestra correos de ejemplo: los campos
  visibles son únicamente `Correo` y `Contraseña`.
- Isotipo y wordmark forman un bloque compacto, pequeño y de separación mínima;
  `Iniciar sesión` funciona como subtítulo ligero. La marca, el subtítulo, los
  campos y el botón conservan una separación corta y uniforme.

### Pruebas de calidad y carga

```bash
ios/app/scripts/run-ios-ui-tests.sh
RISTAK_SOAK_CHAT_COUNT=10000 RISTAK_SOAK_ITERATIONS=250 \
  ios/app/scripts/run-ios-chat-soak.sh
ios/app/scripts/run-ios-live-smoke.sh
```

La suite UI normal y el soak usan fixtures sintéticos, y la regresión de
presentación monta el `InboxScreen` real con un modelo vacío controlado. Ninguno
requiere sesión ni toca la red; `APIClient` bloquea el transporte cuando el
harness declara red deshabilitada. Los unit tests también ejercitan el reductor
real del inbox con 10,000 contactos y promociones repetidas. El smoke real es
opt-in y solo reutiliza la sesión/configuración que ya exista en el destino; no
recibe credenciales por argumentos ni entorno.
Puedes cambiar el simulador con `RISTAK_IOS_DESTINATION` y cada script deja su
`.xcresult` bajo el directorio temporal para inspección, con `DerivedData`
aislado y validación de la ruta antes de limpiar un resultado anterior.

## Arquitectura

Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Contratos exactos de API,
modelos y UX por módulo: [`docs/research/01–16*.md`](docs/research/) (fuente de
verdad; incluyen apéndices de auditoría). Estructura:

```
ios/app/Ristak/
  App/            Entrada, RootView (splash/login/shell), AppDelegate (push)
  Core/           API, Auth/Keychain, Config, Modelos, Servicios, Realtime
                  (SSE + polling), Push, Media, Formateo (TZ/moneda de negocio)
  DesignSystem/   Tokens de marca + componentes reutilizables
  Navigation/     Shell adaptativo (TabView sidebarAdaptable)
  Features/       Login, Chats (Inbox/Thread/Composer/ContactInfo),
                  Calendars, Payments, Analytics, Settings
```

El pbxproj usa grupos sincronizados: **agregar un `.swift` bajo
`ios/app/Ristak/` lo compila automáticamente; nunca edites `project.pbxproj`
para añadir archivos.**

Reglas duras: fechas/rangos siempre con `account_timezone`; dinero siempre con
`account_currency` (si no se puede leer, se bloquea la creación de cobros);
selección (chips/tabs/slots) = relleno sólido de acento + texto blanco, glass
solo en capa flotante; copy en español.

## Qué está implementado

- **Sesión**: login con resolución de tenant, token JWT en Keychain, verify al
  arrancar/volver al frente (solo 401/403 desloguean), logout doble (cerrar
  sesión / cambiar de app), licencia bloqueada, permisos por módulo
  (`accessConfig`) gateando secciones y acciones.
- **Chats** (pantalla principal): bandeja con paginación/merge, búsqueda,
  chips de filtro reales + manager persistido en `app_config`, números de
  WhatsApp, presets condicionales, archivados y silenciados (locales), fila
  fija del Asistente AI, selección múltiple con alcance visible o todo el inbox
  (incluidas conversaciones no cargadas) y acciones masivas, long-press
  → Más acciones (agente, cita, pago, programar, etiqueta, leído, archivar),
  swipe nativo por fila: izquierda **Más → Archivar/Restaurar** y derecha
  **No leído → Fijar/Desfijar**, con fijados arriba y estado local persistente,
  cache en disco para arranque en frío, progreso real por etapas durante la
  primera conexión sin snapshot; si los contactos ya están listos pero la
  bandeja sufre timeout, abre en modo degradado y la reintenta silenciosamente
  en vez de bloquear toda la app en 78 %. SSE + polling 20s, badge de no leídos.
  La fila fija **Asistente Personal AI** abre una conversación nativa real —no
  un placeholder— sobre `/api/ai-agent/chat`, usando la misma configuración de
  OpenAI y contexto de negocio que escritorio. Permite texto y notas de voz
  transcritas, conserva las últimas 24 intervenciones y la categoría entre
  continuaciones, interpreta Markdown, muestra fuentes y opciones aclaratorias,
  permite iniciar una conversación limpia y guía al usuario si OpenAI falta o
  requiere reconexión. No expone acciones de contacto, WhatsApp, cita o cobro.
  Conversación: todos los tipos de mensaje (texto, foto, video, nota de voz,
  documento, ubicación, email desplegable, comentarios FB/IG, sistema), texto
  con formato WhatsApp en globos y previews (`*negrita*`, `_italica_`,
  `~tachado~`, código/monospace, listas y citas), receipts, respuestas con
  swipe, reacciones por canal, mensajes programados
  (crear/editar/cancelar), info de mensaje, reintento de fallidos, carga de
  historial hacia atrás, polling 7s + presencia (suprime push y marca leído).
  Los hitos de cita y pago viven en tarjetas centradas responsive, con borde
  semántico y detalle de hasta dos líneas; nunca crecen fuera de la ventana por
  nombres, horarios, conceptos o montos largos.
  Al desplazarse hacia mensajes anteriores, la flecha flotante **Bajar al final**
  cancela el arrastre o la inercia que siga activa y vuelve al último mensaje con
  un solo toque; el anclaje se reafirma durante la materialización diferida del
  historial y después el control se oculta.
  Las reacciones conservan su emoji aunque el mensaje objetivo esté fuera de la
  página cargada o la app arranque desde una caché anterior; los stickers se
  reconocen como imagen en vez de degradarse al texto genérico `Mensaje`.
  Fotos y videos ocupan el globo completo, con puntita visible y hora/acuse
  superpuestos; video agrega duración dentro del contenido. Ambos reservan desde
  el primer render un canvas fijo 4:3, incluso si el primer payload solo trae
  `messageType` y la URL aparece en el refresh siguiente; pasar de placeholder a
  bitmap o thumbnail nunca cambia la altura ni mueve el scroll. La miniatura de
  video se genera y prepara fuera del hilo visual, se reutiliza al reciclar la
  fila y el estado de espera es estático para evitar tirones o destellos.
  El teclado conserva materializadas las burbujas al primer enfoque: el ancla al
  fondo es solo inicial y los cambios de frame se estabilizan con la duración de UIKit.
  Composer: cámara directa junto al micrófono para foto/video (se oculta al
  empezar a escribir), envío con flecha inmediata sin transición, adjuntos
  (galería/documentos/ubicación), notas de voz,
  plantillas cuando la ventana de 24h está cerrada, selector inferior de
  número/canal antes de `+` con preferencia persistente por contacto y compartida
  con web/Android,
  sugerencia IA opt-in y apagada por default desde Ajustes, controles del agente
  (pausar/tomar/omitir/continuar + confirm
  de envío manual). Info del contacto: edición, tags, campos personalizados
  definidos por el usuario (sin metadatos internos), automatización debajo de
  etiquetas y revalidación silenciosa sin loader sobre el avatar,
  pagos/citas embebidos, fusión de duplicados por teléfono.
- **Calendarios**: mes + agenda del día + timeline día/semana con selección de
  rango por long-press, Nueva cita (Por defecto con slots libres reales /
  Personalizado con ruedas), invitados, detalle con estados
  (pendiente/confirmada/cancelada/asistió/no asistió/reagendada), edición y
  eliminación, 409 de choque con "crear de todos modos", round robin.
  iPad: calendario + panel lateral.
- **Pagos**: pago único manual (con Idempotency-Key) o link de pasarela
  (Stripe/Conekta/Mercado Pago/CLIP/Rebill según integraciones activas) con
  impuestos y MSI, parcialidades, suscripciones (alta + lista con acciones),
  precios guardados (CRUD), últimos pagos por periodo con detalle, sheet de
  link listo (copiar/compartir/abrir), SSE de pagos. iPad: lista + detalle.
- **Analíticas**: 8 KPIs con variación, gráfica financiera con scopes
  (Todos/Al registro/Anuncios) y 5 series, embudo con labels custom,
  distribución de origen (4 dimensiones) y origen por número de WhatsApp,
  rangos 30d/60d/180d/año/personalizado en zona del negocio, estado
  "sin acceso" para la trampa de módulo dashboard. Los filtros horizontales
  arrancan alineados con el contenido de cada tarjeta y, al deslizar, se recortan
  en su borde exacto; Swift Charts reserva 20 % de techo y agrega rellenos
  degradados bajo las líneas. iPad en grid.
- **Ajustes**: números de WhatsApp (principal, bandeja junta/separada),
  plantillas, Asistente AI (contexto de negocio + dictado por voz →
  transcripción), lista de chat, campos personalizados y etiquetas con alta y
  eliminación, apariencia
  (sistema/claro/oscuro/auto), privacidad (confirmaciones de lectura),
  notificaciones (activación de push, toggles por tipo, calendarios con
  alerta), versión y cierre de sesión.
- **Push y realtime**: registro del token APNs en `/api/push/mobile-devices`,
  deep links de notificación (chat/cita/pago), refresh al recibir push en
  foreground/background, precarga del hilo señalado por `content-available`,
  BGAppRefresh oportunista, Notification Service Extension para avatar/media en iOS, SSE
  `chat-events` + `payment-events` con reconexión. `OSLog` y el ring sanitizado
  registran hitos de configuración/token/registro/recepción sin guardar secretos.
- **Rendimiento cotidiano**: directorio cache-first para nuevo chat, citas y
  pagos, con la foto persistida de WhatsApp/Meta y conservación del avatar ya
  hidratado en la bandeja para no degradar citas/pagos a iniciales; hidratación
  externa de avatares fuera del request de listas, en cola backend deduplicada;
  hidratación puntual/coalescida de un chat fuera de la página al llegar
  SSE/push; hasta seis hilos recientes precargados; apertura fijada al ultimo
  mensaje mientras cambia timeline/altura, cancelable al primer gesto, sin
  habilitar paginacion historica prematura; vacios contradictorios quedan como
  error reintentable y las escrituras de snapshot son monotónicas por hilo;
  historial primario
  visible antes de cargar datos secundarios; adjuntos
  por multipart directo a storage/CDN con fallback legacy fuera del hilo visual.
- **Calidad operativa**: `mxSignpost` agregado por `MetricKit`, `OSLog`, ring local
  sanitizado, unit tests, XCUITest sin red, smoke real opt-in y soak de
  10,000-50,000 filas mediante scripts en `ios/app/scripts/`. El harness de hilo
  largo verifica que un flick con inercia seguido de un único toque en **Bajar al
  final** presenta el último mensaje y oculta la flecha.

## Pendientes / brechas conocidas

Configuración (no es código de la app):
- **Push**: la app nativa Apple ya usa el topic oficial `com.ristak.app`. El
  backend o el broker del Installer debe mantener `APNS_BUNDLE_ID` /
  `mobile_apns_bundle_id` en `com.ristak.app` para que las notificaciones
  lleguen a esta app.

Backend/product (documentadas en `docs/research/*` como OPEN QUESTION):
- Notas de voz **entrantes** OGG/Opus: AVPlayer no las decodifica; hoy se
  muestra un aviso. Solución real: transcodificar a m4a en backend.
- Archivados/silenciados son locales por dispositivo (no existe endpoint de
  sincronización; misma limitación que la app RN).
- Sin UI todavía: cobro con tarjeta guardada, envío del link de pago por
  canal (WhatsApp/email), ruta de invoices HighLevel para pago único,
  respuesta pública a comentarios FB/IG, recordatorios de cita (solo lectura
  en Core), bloqueos de horario (solo escritorio), reenviar mensaje (también
  placeholder en RN/escritorio).
- El backend no manda badge count: el globo de la app se alimenta del unread
  local mientras la app está abierta.

## Endpoints

La app consume exclusivamente los endpoints existentes del backend — no se
agregó ni cambió ningún contrato. El inventario completo por módulo, con
parámetros y formas de respuesta, está en `ios/docs/research/01-api-conventions.md`
(inventario maestro) y en el doc de cada módulo (03–12).
