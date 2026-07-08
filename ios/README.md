# Ristak iOS — App nativa universal (iPhone + iPad)

App nativa SwiftUI para operar el CRM Ristak desde iPhone y iPad. Usa el
backend existente (mismos endpoints, auth, permisos y reglas que el escritorio
y `/movil`), con navegación nativa de iOS 26 y Liquid Glass.

- Proyecto: `ios/app/Ristak.xcodeproj` (target único `Ristak`)
- Bundle id: `com.ristak.ios` (los ids `com.ristak.app` y `com.ristak.native`
  están reservados para la app de tienda Capacitor y la app React Native)
- Mínimo: iOS 26.0 · Xcode 26+ · Swift 5 mode · **cero dependencias externas**
- Universal: iPhone (tab bar compacta) + iPad (sidebar adaptable, split views,
  popovers), vertical y horizontal, claro/oscuro, Dynamic Type.

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
xcrun devicectl device process launch --device <UDID> com.ristak.ios
```

### Login
- **Producción**: correo + contraseña de la cuenta. El correo resuelve el
  tenant automáticamente vía `POST https://www.ristak.com/api/mobile/resolve`
  y la app queda apuntando al servidor de esa instalación.
- **Desarrollo local**: `./start-local.sh` en la raíz del repo (backend en
  `:3001`) y en el login abrir **Opciones avanzadas → Servidor** con
  `http://127.0.0.1:3001` (ATS ya permite redes locales).

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
  fija del Asistente AI, selección múltiple con acciones masivas, long-press
  → Más acciones (agente, cita, pago, programar, etiqueta, leído, archivar),
  cache en disco para arranque en frío, SSE + polling 20s, badge de no leídos.
  Conversación: todos los tipos de mensaje (texto, foto, video, nota de voz,
  documento, ubicación, email desplegable, comentarios FB/IG, sistema),
  receipts, respuestas con swipe, reacciones por canal, mensajes programados
  (crear/editar/cancelar), info de mensaje, reintento de fallidos, carga de
  historial hacia atrás, polling 7s + presencia (suprime push y marca leído).
  Composer: adjuntos (cámara/galería/documentos/ubicación), notas de voz,
  plantillas cuando la ventana de 24h está cerrada, selector de número/canal,
  sugerencia IA, controles del agente (pausar/tomar/omitir/continuar + confirm
  de envío manual). Info del contacto: edición, tags, campos personalizados,
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
  "sin acceso" para la trampa de módulo dashboard. Swift Charts, iPad en grid.
- **Ajustes**: números de WhatsApp (principal, bandeja junta/separada),
  plantillas, Asistente AI (contexto de negocio + dictado por voz →
  transcripción), lista de chat, campos personalizados, apariencia
  (sistema/claro/oscuro/auto), privacidad (confirmaciones de lectura),
  notificaciones (activación de push, toggles por tipo, calendarios con
  alerta), versión y cierre de sesión.
- **Push y realtime**: registro del token APNs en `/api/push/mobile-devices`,
  deep links de notificación (chat/cita/pago), refresh al recibir push en
  foreground, SSE `chat-events` + `payment-events` con reconexión.

## Pendientes / brechas conocidas

Configuración (no es código de la app):
- **Push**: el topic APNs del backend (`APNS_BUNDLE_ID`, o el broker del
  Installer) apunta hoy a `com.ristak.app`; debe configurarse a
  `com.ristak.ios` para que lleguen notificaciones a esta app.

Backend/product (documentadas en `docs/research/*` como OPEN QUESTION):
- Notas de voz **entrantes** OGG/Opus: AVPlayer no las decodifica; hoy se
  muestra un aviso. Solución real: transcodificar a m4a en backend.
- Archivados/silenciados son locales por dispositivo (no existe endpoint de
  sincronización; misma limitación que la app RN).
- Extensión de notificaciones (Communication Notifications con avatar)
  requiere un target adicional de Xcode — siguiente iteración.
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
