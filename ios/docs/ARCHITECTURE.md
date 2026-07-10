# Ristak iOS — Arquitectura

App universal nativa (iPhone + iPad), SwiftUI, iOS 26, Liquid Glass. Vive en
`ios/app/Ristak.xcodeproj` (target único `Ristak`, bundle `com.ristak.app`).
El proyecto usa **grupos sincronizados por sistema de archivos**: agregar un
`.swift` bajo `ios/app/Ristak/` lo incluye automáticamente — **nunca edites
`project.pbxproj`** para añadir archivos.

Fuente de verdad de contratos: `ios/docs/research/*.md` (01–16). No inventes
endpoints ni reglas: si algo no está en esos docs, ve al código fuente del
backend/frontend y documenta la brecha.

## Reglas globales

- Swift 5 mode, async/await, `@Observable` (framework Observation). Nada de
  Combine salvo necesidad puntual. ViewModels `@MainActor`.
- **Cero dependencias de terceros.** Solo SDK de Apple.
- Copy de UI en **español**, exactamente el copy documentado en research
  (acentos correctos aunque RN no los tenga).
- Fechas/rangos SIEMPRE con `account_timezone` (nunca el reloj del dispositivo);
  moneda SIEMPRE `account_currency` con formato `es-MX`. Helpers en
  `Core/Formatting/`.
- Tipografía SF Pro (sistema) + Dynamic Type. La identidad de marca va por
  color/forma, no por fuentes embebidas.
- Liquid Glass según `research/16-apple-liquid-glass-swiftui.md`: glass SOLO en
  la capa flotante de navegación/controles (tab bar, toolbars, FABs, chips
  flotantes, composer bar); el contenido (listas, burbujas, tarjetas, tablas)
  va en capas opacas legibles. Nunca glass sobre glass. No pongas fondos custom
  a bars/sheets — deja que el sistema aplique glass. Respeta
  `accessibilityReduceTransparency` / `reduceMotion`.
- Haptics con `.sensoryFeedback` en acciones equivalentes a las de RN
  (long-press, envío, confirmaciones, selección de slots).
- Errores: mensajes claros + botón "Reintentar" cuando aplique. Estados
  loading (skeleton/ProgressView), empty y error estándar de
  `DesignSystem/Components/StateViews.swift`.

## Estructura de carpetas (ownership por agente)

```
ios/app/Ristak/
  App/                    RistakApp, RootView, AppDelegate (push)
  Core/
    API/                  APIClient, Endpoint helpers, errores, envelopes
    Auth/                 KeychainStore, SessionStore, TenantResolver, AccessStore
    Config/               AppConfigStore (config global + user-config, tema)
    Models/               Todos los Codable (por módulo: ChatModels.swift, ...)
    Services/             Un servicio por módulo (funciones endpoint tipadas)
    Realtime/             ChatEventsClient (SSE), PaymentEventsClient, PollingClock, PresenceReporter
    Formatting/           BusinessFormatters (fechas relativas, moneda, duraciones)
    Push/                 PushRegistrar, NotificationRouter (deep links)
    Media/                MediaEncoder (data URLs, límites), ImageCache/loader
  DesignSystem/
    Theme.swift           Tokens (colores semánticos, spacing, radios)
    Components/           Avatar, ChannelBadge, FilterChip, KPICard, StateViews,
                          GlassFAB, SheetScaffold, SearchField, TagPill, ...
  Navigation/
    MainShell.swift       TabView adaptativo (iPhone tab bar / iPad sidebar)
  Features/
    Login/
    Chats/                Inbox/ + Thread/ + Composer/ + ContactInfo/
    Calendars/
    Payments/
    Analytics/
    Settings/
  Resources/              channel-badges/, chat-wallpaper.webp
```

Cada feature expone una vista raíz con nombre fijo: `ChatsRootView`,
`CalendarsRootView`, `PaymentsRootView`, `AnalyticsRootView`,
`SettingsRootView` (el shell las referencia). Trabaja solo dentro de tu
carpeta asignada + lee (sin modificar) el resto.

## Núcleo de red (doc 01)

- `TenantResolver`: `POST https://www.ristak.com/api/mobile/resolve`
  `{identifier}` → `tenant.app_url` (errores: `tenant_not_found`,
  `client_inactive`, `installation_not_ready`, `rate_limited` 429).
- `APIClient` (actor): base URL del tenant + `Authorization: Bearer <jwt>`.
  Timeout 15s default (60s para envíos con media, 30s dashboard). Sin CORS.
  Cada request captura un contexto inmutable `{baseURL, token, generation}`:
  una respuesta o reintento que comenzó en la cuenta anterior no puede cambiar
  la sesión nueva ni reconstruirse contra otro tenant. Sin conectividad falla
  rápido; caché/polling/reintento explícito recuperan sin dejar pantallas pegadas.
- **Regla de envelope**: decodifica `{success, data}` y desenvuelve SOLO si
  ambos existen; si no, decodifica la forma específica del endpoint
  (`{success, config}`, `{success, timezone}`, arrays pelados, `{products}`…).
  Implementa helpers: `DataEnvelope<T>`, `KeyedEnvelope`, decode tolerante
  (campos opcionales, snake_case mixto con camelCase — usa `CodingKeys`
  explícitos según research, NO `convertFromSnakeCase` global).
- Manejo global (en `APIClient` + `SessionStore`):
  - 401 (incl. `token_revoked`) → limpiar Keychain → pantalla de login.
  - 403 `license_blocked` → logout + alerta única "Licencia suspendida".
  - 403 `feature_not_available` → silencioso en GET; alerta solo en acciones.
  - 403 `read_access_required`/`write_access_required` → error tipado para que
    la vista muestre estado "sin acceso" (no logout).
  - 503 `Aplicación iniciando` → transitorio: reintento con backoff solo
    para `GET`/`HEAD`. Nunca se repite automáticamente una escritura.
  - 429 `rate_limited` → mensaje con espera.
- `RistakAPIError`: `{status, code?, message, feature?, module?}`.

## Sesión (doc 02)

- `KeychainStore`: `baseURL`, `token`, snapshot de `user` (JSON). Servicio
  `com.ristak.app`.
- `SessionStore` (@Observable, en Environment):
  `phase: .booting | .loggedOut | .active(RistakUser?)`.
  - Arranque: si hay token → entrar al shell optimista + `POST /api/auth/verify`
    (`{token}` en body, timeout 8s). Solo 401/403 desloguean; error de red
    mantiene sesión con `user` cacheado.
  - Login: resolver tenant → `POST /api/auth/login` `{email, password}` →
    `{token, user}` → persistir. Re-verify al volver a foreground (scenePhase).
  - Logout: local (limpiar Keychain + cachés + `DELETE /api/push/mobile-devices`
    best-effort).
- `AccessStore`: port 1:1 de `mobile/src/access.ts` (doc 13): secciones del
  shell por `accessConfig` — chat→`chat`, citas→`appointments`,
  pagos→`payments`, analíticas→`analytics`, ajustes→`settings_mobile`;
  admin todo write; filtrar por read; `user == nil` (cargando) → permitir.
  Con un usuario ya resuelto cuya lista quede vacía, mostrar solo Ajustes para
  explicar el acceso y permitir cerrar sesión; nunca abrir todos los módulos por
  fallback. Analíticas además maneja 403 de módulo `dashboard` con estado "sin
  acceso" (trampa doc 09/13).

## Config (doc 10)

`AppConfigStore` (@Observable): carga `GET /api/settings/timezone`,
`GET /api/config?keys=...` (batch) y `GET /api/user-config`. Valores string
("1"/"true"/"yes"/"on" → bool). Escrituras optimistas con rollback
(`POST /api/config`, `PATCH /api/user-config`). Tema:
`mobile_chat_theme_preference` system|light|dark|auto (auto = oscuro
19:00–06:00 hora del negocio) → `preferredColorScheme`.
Las cargas y escrituras llevan generación de sesión y secuencia de carga: un
resultado viejo no puede hidratar, cachear ni ejecutar rollback sobre la cuenta
que acaba de entrar.

## Realtime (doc 11)

- `ChatEventsClient`: SSE por `URLSession.bytes` a `/api/chat-events/stream`
  con header Bearer (eventos `connected`, `chat_message`); heartbeats `:` cada
  25s; reconexión 1s→15s exponencial. Antes del refresh REST autoritativo, la
  app aplica la actividad mínima conocida: deduplica el evento, actualiza el
  preview disponible y mueve la fila del contacto al inicio. Un envío optimista
  usa el mismo puente aunque el hilo cubra la bandeja en iPhone. Los refresh
  vivos consultan `/contacts/chats` con `warmProfilePictures=false`; el
  calentamiento remoto de avatares queda para arranque frío/paginación.
- `PollingClock`: bandeja 12s, hilo abierto 4s, receipts 12s; pausa en
  background.
- `PresenceReporter`: `POST /api/chat-events/viewing {contactId, foreground}`
  cada 20s mientras un hilo está visible (traga 403 silenciosamente).
- `PaymentEventsClient`: `connected`, `payment_changed` y
  `subscription_changed` reconcilian por REST con debounce. El stream se detiene
  en background, se vuelve a abrir en foreground y `connected` cubre eventos
  perdidos porque SSE no tiene replay.

## Push (doc 11)

- `PushRegistrar`: pedir permiso, registrar token APNs **hex** en
  `POST /api/push/mobile-devices {token, platform:"ios", calendarIds,
  appVersion, appBuild, deviceModel, osVersion, clientType:"native",
  appPackage:"com.ristak.app"}`. El permiso de iOS y el registro confirmado por
  backend son estados distintos: "activo" exige ambos. Serializa activaciones,
  reintenta fallos transitorios a 5/15/60/300 s y revalida en foreground si la
  confirmación supera 6 h.
- `NotificationRouter`: tap → deep link por `contactId`/`url`/`category`
  (chat, cita, pago). Badge: solo local desde unread de bandeja (el backend no
  manda badge).
- Topic APNs: el backend (`APNS_BUNDLE_ID`, default `com.ristak.app`) y el
  broker del Installer exigen exactamente `com.ristak.app`; un topic legacy o
  distinto no cuenta como iOS configurado. Es la identidad oficial de la app
  SwiftUI Apple.
- `RistakNotificationService`: extensión embebida con bundle
  `com.ristak.app.NotificationService`; procesa `mutable-content`, descarga
  avatar/media pública y entrega Communication Notifications con el remitente
  correcto. Su estado y callbacks se serializan para finalizar una sola vez;
  usa timeouts de 6–7 s y rechaza avatares mayores a 5 MB o adjuntos mayores a
  12 MB.
- Logout explícito hace `DELETE /api/push/mobile-devices` best-effort y luego
  limpia registro/APNs local. En 401, licencia revocada o cierre sin credencial,
  la limpieza local ocurre de inmediato aunque el DELETE ya no sea posible.

## Media (doc 12)

- Envíos de chat: base64 **data URL** en JSON (`imageDataUrl` etc.). Límites de
  entrada: imagen 25MB (JPG/PNG/WebP/HEIC decodificable), video 25MB
  (MP4/MOV), audio 16MB (envía m4a/AAC, el backend transcodifica), doc 20MB.
  `MediaEncoder` reduce toda foto a un máximo de 1600 px, la convierte a JPEG
  0.80 antes del base64 y centraliza límites/errores en español; no debe mandar
  la foto completa de cámara para que el backend la reduzca después. El
  backend conserva un preview M4A reproducible para API y QR y normaliza el
  alias detectado `audio/x-m4a` a `audio/mp4` antes de guardarlo.
- Reconciliación visible: `ConversationViewModel` conserva el `id`, fecha y data
  URL del globo optimista; al llegar la fila del servidor absorbe status, WAMID y
  URL remota dentro de esa misma burbuja y oculta la fila duplicada. Los polls no
  deben cerrar/reabrir el preview ni provocar saltos del `ScrollView`.
- La codificación/lectura de foto, video, audio y documentos corre fuera del
  `MainActor`; mientras se prepara media el composer bloquea enviar/adjuntar.
  El tray admite hasta 4 adjuntos y un máximo acumulado de 40 MB binarios para
  evitar picos de memoria por base64.
- Render: URLs de media públicas (CDN) — `ImageLoader` con caché en memoria y
  disco. Visor pantalla completa con zoom, player audio con velocidades y
  scrubber alineado a los extremos sin parecer recortado, QuickLook para
  documentos, mapa para ubicación.

## Navegación / shell

- Calendarios cachea citas por `calendarID + yyyy-MM`; al cambiar calendario
  limpia las filas anteriores, hidrata solo el snapshot correcto y revalida al
  volver a foreground.
- Pagos recientes pide al backend `statuses=paid,partial`, no escanea páginas de
  pendientes. Un precio con moneda distinta a `account_currency` bloquea el
  cobro. Si se pierde la respuesta de una tarjeta guardada, el resultado queda
  `unknown` y no se permite reintentar a ciegas hasta revisar el historial. Cada
  intento lleva `clientRequestId` persistente; backend y proveedor deduplican y
  reproducen la respuesta sin crear otro cargo.
- Analíticas conserva snapshots stale-while-revalidate, pero muestra aviso si
  no se actualizaron sus cuatro paneles. La carga de números de WhatsApp es
  independiente de Origen y solo reemplaza su caché cuando responde con éxito.

- `MainShell`: `TabView` con `Tab` tipadas (Chats por defecto, orden: Chats,
  Calendarios, Pagos, Analíticas, Ajustes) + `.tabViewStyle(.sidebarAdaptable)`
  → tab bar inferior en iPhone, sidebar adaptable en iPad.
  `tabBarMinimizeBehavior(.onScrollDown)` en iPhone.
- Chats/Pagos/Ajustes: `NavigationSplitView` en ancho regular (lista |
  detalle), `NavigationStack` en compacto. Calendarios: calendario + detalle
  en iPad. Analíticas: grid adaptativa por `horizontalSizeClass`.
- Sheets con `presentationDetents`; en iPad usar `popover` para filtros y
  pickers cuando sea natural.

## Design system

`Theme.swift`: mapear la marca (azul `#3278ff` = AccentColor ya en assets;
semánticos pos/neg/warn/info de doc 15) sobre colores dinámicos claro/oscuro.
Componentes reutilizables en `DesignSystem/Components/` — toda vista de
feature debe usarlos (avatars con iniciales+badge de canal, chips de filtro,
KPI cards, estados vacíos, etc.).

Los iconos oficiales del launcher viven en
`Ristak/Assets.xcassets/AppIcon.appiconset`: `icon-light.png` para modo claro,
`icon-dark.png` para modo oscuro e `icon-tinted.png` para el modo tinted de
iOS. Deben mantenerse como PNG 1024x1024 RGB sin canal alfa; no subas iconos con
transparencia porque pueden fallar la validacion de iOS/App Store.

**Regla de selección (preferencia explícita de Raúl, hereda de la app RN):**
chips, tabs y slots seleccionados usan **relleno sólido de acento + texto
blanco** (superficie plana, sin glass, sin contorno, sin sombra). El estado no
seleccionado usa superficie neutra (`var(--surface)` equivalente nativo). El
glass queda reservado para overlays/controles FLOTANTES (FABs, barras,
sheets del sistema), nunca para comunicar selección.

## Verificación

- Compilar: `xcodebuild -project ios/app/Ristak.xcodeproj -scheme Ristak
  -destination 'id=BFC68803-AC13-45B2-8664-BA6C99AAA6A1' build`
  (iPhone 17 Pro sim; iPad: `id=88C0E42B-1FAC-4470-8EF8-87A1B0064A25`).
  Usa `-derivedDataPath` propio si compilas en paralelo con otros agentes.
- Login: la app resuelve tenant por correo contra el portal central y no muestra
  campo manual de servidor. El override directo queda reservado para pruebas
  internas, fuera de la UI de usuario.
