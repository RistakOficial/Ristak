# 14 — Inventario UX de la app React Native (`mobile/`)

> **Propósito.** Este documento inventaría la app React Native/Expo existente
> (`mobile/src/App.tsx`, ~32.000 líneas) como **inspiración de diseño** para la
> app nativa SwiftUI (iPhone + iPad, iOS 26, Liquid Glass). La app nativa debe
> **adaptar**, no clonar; pero la RN es hoy la referencia visual/interactiva
> más fiel del producto móvil (a su vez espejo de `/movil`).
>
> **Fuentes leídas:** `mobile/src/App.tsx`, `mobile/src/format.ts`,
> `mobile/src/access.ts`, `mobile/src/storage.ts`, `mobile/README.md`,
> `mobile/AGENTS.md`, `docs/MOBILE_APP.md` (secciones UX). Los números de línea
> citados corresponden al estado del repo el 2026-07-07.

---

## 1. Arquitectura de pantallas (mapa completo)

### 1.1 Máquina de estados raíz

`RistakNativeApp` (`App.tsx:1148`) maneja tres pantallas raíz
(`type Screen = 'boot' | 'login' | 'shell'`, línea 366):

| Pantalla | Componente | Cuándo |
|---|---|---|
| `boot` | `BootScreen` (`:2116`) | Arranque: lee `baseUrl` + token de SecureStore y verifica sesión (`/auth/verify` con timeout de 8 s, `BOOTSTRAP_SESSION_VERIFY_TIMEOUT_MS`, `:358`). Logo Ristak + `ActivityIndicator` ("Cargando"). |
| `login` | `LoginScreen` (`:2132`) | Sin token o verificación 401/403. |
| `shell` | `PhoneShell` (`:1277`) | Sesión válida (o verificación con error de red: entra optimista al shell). |

Reglas de sesión visibles en UX:

- **Licencia suspendida:** callback `onLicenseBlocked` limpia el token, regresa
  a login y muestra `Alert` una sola vez: *"Licencia suspendida — Tu licencia
  de Ristak ya no está activa. Inicia sesión de nuevo cuando se reactive."*
  (`:1152-1163`).
- **Función bloqueada por plan:** `Alert` *"Función no disponible — Esta
  función no está incluida en tu plan. Pídele al administrador que la
  active."* (`:1164-1169`).

### 1.2 Shell: 5 secciones con dock inferior

`PHONE_NAV_ITEMS` (`:659-665`) — **orden exacto** e iconos Lucide:

| # | key | Label | Icono |
|---|---|---|---|
| 1 | `settings` | Ajustes | `Settings` |
| 2 | `chat` | Chats | `MessageCircle` (badge de no leídos) |
| 3 | `calendar` | Citas | `CalendarDays` |
| 4 | `payments` | Pagos | `CircleDollarSign` |
| 5 | `analytics` | Analíticas | `BarChart3` |

La sección inicial es `chat` (`:1290`). Las secciones se filtran con
`hasPhoneSectionAccess(user, key)` (`access.ts:79`): mapea sección→módulo
(`chat→chat`, `calendar→appointments`, `payments→payments`,
`analytics→analytics`, `settings→settings_mobile`), respeta
`user.accessConfig` (niveles `none|read|write`, admin = todo) y el mapa de
features de licencia (`licenseEnforced`/`licenseFeatures`, con claves legacy —
`access.ts:21-30`). Si el usuario aún no resuelve (verify en curso), **no se
oculta nada** (backend sigue validando por request). Cada sección se envuelve
en `PhoneSectionErrorBoundary` (`:677`): en crash muestra *"Esta pantalla se
atoró / Ristak no se va a cerrar. Vuelve a intentarlo."* + botón "Reintentar".

### 1.3 Árbol completo de pantallas / overlays

```
RistakNativeApp
├─ BootScreen
├─ LoginScreen
└─ PhoneShell
   ├─ PhoneDock (flotante, Liquid Glass, oculto con conversación/asistente abiertos)
   ├─ ChatScreen (sección Chats)
   │  ├─ AssistantConversationScreen (chat IA, reemplaza pantalla completa)
   │  ├─ NativeConversationScreen (capa de ruta push desde la derecha)
   │  │  ├─ NativeContactDetailScreen (Info del contacto, pantalla completa)
   │  │  │  └─ subpáginas: Pagos totales · Citas · Archivos del chat (tabs
   │  │  │     Fotos y videos/Documentos/Enlaces) · Viaje de cliente ·
   │  │  │     Historial del agente · Detalle de pago · Detalle de cita
   │  │  │     └─ ContactInfoOurNumberSheet ("Contactando desde")
   │  │  └─ sheets: Attachments (Acciones) · Canal · Acciones de mensaje ·
   │  │     ChatMore (Más acciones) · Etiqueta · Programar mensaje ·
   │  │     Plantillas · CLABE · Registrar pago · Agendar cita ·
   │  │     "Agente activo" (interrupción manual)
   │  └─ sheets de bandeja: FilterManagerSheet · ChatMoreSheet ·
   │     ContactTagSheet · ScheduleMessageSheet · ContactPickerSheet
   │     (modo "Nuevo chat" y modo "Enviar media" post-cámara)
   ├─ CalendarSection (sección Citas)
   │  └─ sheets: CalendarPickerSheet · AppointmentContactPickerSheet ·
   │     CalendarEventDetailsSheet · AppointmentFormSheet
   ├─ PaymentsSection (sección Pagos, dentro de AppFrame)
   │  ├─ vistas internas: select · single · partial · subscription · products
   │  └─ sheets: AppointmentContactPickerSheet (elegir cliente) ·
   │     BottomActionSheet "Fecha personalizada"
   ├─ AnalyticsSection (sección Analíticas)
   │  └─ BottomActionSheet "Fecha personalizada"
   └─ SettingsScreen (sección Ajustes)
      └─ paneles push in-place: numbers · templates · agent · chats ·
         custom-fields · appearance · privacy · notifications
```

Nota de navegación: **no usa react-navigation**. Todo es estado local +
`Animated`. La "ruta" conversación es una capa absoluta
(`ConversationRouteLayer`, `:1611`) encima de la lista.

---

## 2. Sistema de tema (paletas exactas)

### 2.1 Paleta oscura (`DARK_COLORS`, `App.tsx:247-263`)

| Token | Valor |
|---|---|
| `bg` | `#050506` |
| `panel` | `#111114` |
| `panelSoft` | `#1c1c1e` |
| `border` | `rgba(235,235,245,0.16)` |
| `text` | `#f5f5f7` |
| `muted` | `#a1a1aa` |
| `accent` / `primary` | `#636366` (gris iOS; **no azul, no verde**) |
| `accentSoft` | `rgba(118,118,128,0.24)` |
| `success` | `#18b66f` |
| `danger` | `#ff5d6c` |
| `dangerSoft` | `#6f2030` |
| `meta` | `#c7c7cc` |

### 2.2 Paleta clara (`LIGHT_COLORS`, `:267-283`)

| Token | Valor |
|---|---|
| `bg` / `panel` | `#ffffff` |
| `panelSoft` | `#f5f5f7` |
| `border` | `rgba(60,60,67,0.14)` |
| `text` | `#1d1d1f` |
| `muted` / `meta` | `#6e6e73` |
| `accent` / `primary` | `#1d1d1f` |
| `accentSoft` | `rgba(118,118,128,0.12)` |
| `success` | `#18b66f` |
| `danger` | `#e5485d` |
| `dangerSoft` | `#ffe4e8` |

**Estado del tema claro: totalmente implementado y de primera clase.** La
preferencia se guarda en `app_config.mobile_chat_theme_preference` con valores
`system | auto | light | dark` (`coercePhoneThemePreference`, `:11283`):

- `system`: sigue `Appearance.getColorScheme()` con listener (`:1412-1414`).
- `auto` ("Horario"): oscuro de 19:00 a 05:59 hora local, se reevalúa cada
  60 s (`getNativePhoneThemeTone`, `:11304-1311`; interval `:1415-1417`).
- Al aplicar tema se muta el objeto global `COLORS`, se regeneran los estilos
  (`applyNativePhoneThemePreference`, `:11329-11343`), se pinta el fondo del
  sistema (`SystemUI.setBackgroundColorAsync`) y la status bar
  (`dark-content`/`light-content`). Etiquetas visibles: "Claro", "Noche",
  "Horario: …", "Sistema: …" (`getThemeMeta`, `:11345`).
- **OJO (deuda RN):** el retema en caliente depende de mutación global +
  remount por `resetKey`; en SwiftUI esto se resuelve nativo con
  `ColorScheme`/environment.

### 2.3 Derivados del tema (`createAppStyles`, `:23388-23474`)

Valores útiles para el design system nativo (claro / oscuro):

- Superficie liquid: `rgba(255,255,255,0.56)` / `rgba(28,28,30,0.62)`;
  seleccionada `rgba(255,255,255,0.72)` / `rgba(58,58,60,0.66)`.
- Fondo del dock: `rgba(255,255,255,0.64)` / `rgba(28,28,30,0.62)`.
- Control seleccionable en reposo: `rgba(118,118,128,0.12)` /
  `rgba(255,255,255,0.07)`; **seleccionado = relleno sólido `accent` con texto
  blanco** (regla explícita en comentario `:23398-23401`: chips/tabs/segments
  planos, sin vidrio ni sombra por chip).
- Burbuja entrante: `#ffffff` / `rgba(28,28,30,0.96)`. Burbuja saliente:
  `#e9eaee` / `rgba(58,58,60,0.92)` (ambas neutras, no verdes).
- Burbuja programada: `#f0f1f4` / `rgba(72,72,74,0.48)` + borde punteable.
- Burbuja fallida: `dangerSoft` / `rgba(127,29,29,0.58)`.
- Fondo composer: `#f5f5f7` claro / `panel` oscuro
  (`CONVERSATION_COMPOSER_LIGHT_BACKGROUND`, `:757`;
  `getNativeConversationComposerBackground`, `:11317`).
- Separador de día en chat: `rgba(245,245,247,0.92)` / `rgba(44,44,46,0.82)`.
- Backdrop de sheets: `rgba(29,29,31,0.28)` / `rgba(0,0,0,0.48)`; dimmer
  `rgba(29,29,31,0.34)` / `rgba(0,0,0,0.56)`.
- Avatar fallback: `rgba(60,60,67,0.10)` / `rgba(255,255,255,0.12)` con
  iniciales en color `text` (nunca relleno de color de canal — regla dura en
  `docs/MOBILE_APP.md:736+`).

`CONTACT_INFO_THEME` (`buildContactInfoTheme`, `:328-350`) reusa la paleta con
un token extra `conversationBg` (claro: `panelSoft`; oscuro: `bg`) para el
fondo full-bleed de Info del contacto.

### 2.4 Reglas duras de color (de `docs/MOBILE_APP.md` §"Tema visual móvil")

- Experiencia "iOS/Apple neutral": superficies blancas/grises (claro) y
  negros/grises de sistema (oscuro). **Azul solo para acentos funcionales**
  (CTA principal, badges, links, checks); nunca como relleno de navegación,
  tabs, chips, filtros, icon buttons, sheets ni segmented controls.
- **Verde prohibido como acento global** (recuerda a WhatsApp); reservado a
  marca WhatsApp y estados semánticos de éxito.
- Color social del contacto **solo** en el badge de canal del avatar (assets
  WebP 72×72 rellenos, `mobile/assets/channel-badges/`), nunca como aro ni
  relleno del avatar.
- Iconos de navegación/toolbar con trazo fino (`strokeWidth` ≈ 1.75–2.0).

---

## 3. Tipografía

- **Fuente del sistema** (iOS: San Francisco; `APP_FONT_FAMILY` deja
  `undefined` en iOS, `:23284`).
- Pipeline `applyAppTypography` (`:23354`): a todo estilo de texto se le
  **suaviza el peso** — todo ≤500 se vuelve `400`, todo ≥600 se vuelve `600`
  (`APP_FONT_WEIGHT_MAP`, `:23289`) — **excepto** los títulos fuertes
  (`APP_STRONG_TITLE_STYLE_KEYS`: `analyticsTitle`, `calendarTitle`,
  `chatTitle`, `paymentsSelectTitle`, `settingsTitle`, `sheetTitle`, `title`)
  que conservan 700–900. `letterSpacing` negativo se fuerza a 0.
- Escala de títulos de sección (grandes, tipo iOS Large Title):
  - Chats: 42/47, peso 800 (`chatTitle`).
  - Analíticas: 42/48, peso 900.
  - Ajustes: 40/45, peso 900.
  - Citas (mes): 39/43, peso 900, `textTransform: capitalize`.
  - Pagos: 38/43, peso 900.
- Cuerpo: 400–500; énfasis puntual 600. Mono (`Menlo`) solo para texto
  formateado tipo ``código`` en previews de WhatsApp (`:28423`).
- Info del contacto usa **escala compacta** propia: `PHONE_COMPACT_SCALE =
  0.78` (`phoneCompact()`, `:353-354`) y `allowFontScaling={false}`
  (`ContactInfoText`, `:17838`) para impedir que Dynamic Type rompa la paridad
  (regla documentada en `docs/MOBILE_APP.md` §"Info del contacto nativa").
  **Para iOS nativo: reconsiderar — soportar Dynamic Type es deuda a saldar.**

---

## 4. Liquid Glass y superficies

- `LiquidGlassLayer` (`:23238`): usa `GlassView` de `expo-glass-effect` cuando
  `isGlassEffectAPIAvailable()` (iOS 26); si no, `View` con `fallbackStyle`
  translúcido. Se aplica a: dock, indicador del dock, overlay de acciones de
  mensaje. Tintes usados: dock `rgba(255,255,255,0.34)` claro /
  `rgba(255,255,255,0.08)` oscuro; indicador `rgba(255,255,255,0.58)` /
  `rgba(255,255,255,0.16)`; overlay de mensaje `rgba(255,255,255,0.24)` /
  `rgba(10,10,12,0.34)`; estilo `clear` en dock con animación de
  transición al compactar.
- `LiquidControlSurface/Background` (`:23268-23282`): capa de fondo para
  botones iconográficos y chips. Reposo = pista neutra plana; seleccionado =
  relleno `accent` sólido con texto blanco; variante `soft` para triggers de
  dropdown (resalte sutil que mantiene el texto oscuro legible).
- Regla (docs): el material glass **no** se enciende por scroll; el dock lo
  mantiene siempre y solo cambia de escala. Sin contornos duros ni elevaciones
  pesadas; sombra externa ligera (`dockPanelShadow`: offset y=10, radius 22,
  opacity 0.16 claro / 0.36 oscuro).

**Equivalente SwiftUI:** materiales nativos (`.glassEffect` de iOS 26 /
`Material.ultraThin`) reemplazan a `expo-glass-effect` con ventaja; conservar
las decisiones de *dónde* hay vidrio (dock, icon buttons flotantes, overlay de
acciones) y dónde no (chips/tabs planos).

---

## 5. Navegación, gestos y animaciones (patrones a conservar)

### 5.1 Dock inferior (`PhoneDock`, `:1638-1906`)

- Geometría: flotante, `left/right: 14`, `bottom: 30`
  (`PHONE_DOCK_BOTTOM_OFFSET`), altura mínima 56, radio 28, padding
  horizontal 8. Indicador: cápsula 64×50, radio 25, `top: 3`. Espacio
  reservado bajo listas: `PHONE_DOCK_RESERVED_SPACE = 118` (`:1137-1146`).
- **Solo iconos, sin labels.** Icono chat 25 pt, resto 23 pt; trazo 1.95
  seleccionado / 1.75 reposo. Tema claro: iconos negros siempre; oscuro:
  seleccionado `text`, resto `muted`.
- **Badge** de no leídos en Chats: pill rojo, "99+" como tope (`:1894-1898`).
- **Indicador animado que persigue el dedo:** `PanResponder` sobre todo el
  dock; arranca con `|dx| ≥ 3` y `|dx| > |dy|·1.25`; durante el drag el
  indicador sigue la coordenada X real (clamp entre centros de primera y
  última tab) y el `visualIndex` cambia en vivo; al soltar, anima al índice
  más cercano (130 ms `easeOutCubic`) y selecciona la sección; un
  `suppressNextPress` de 140 ms evita el tap fantasma (`:1744-1818`). Cambio
  por tap: anima 150 ms.
- **Compactación por scroll:** el shell escucha `onTouchMove` global
  (`:1339-1357`); si el gesto es vertical dominante (`|dy| ≥ 4` y
  `|dy| > |dx|·1.15`), scroll hacia abajo ⇒ dock compacto (escala 0.8, 380 ms
  `cubic-bezier(0.16,1,0.3,1)`), hacia arriba ⇒ expande (180 ms easeOutCubic).
  Se resetea al cambiar de sección.
- **Oculto** (`dockHidden`) cuando hay conversación o asistente abiertos
  (`:2334-2337`, `:1545`).

**Equivalente iOS 26:** una `TabView` con Liquid Glass nativo da el material,
pero el "indicador que persigue el dedo" + swipe horizontal para cambiar de
tab es una firma del producto: en SwiftUI se replica con un dock custom
(`matchedGeometryEffect` + `DragGesture`).

### 5.2 Transición entre secciones (`AnimatedShellPage`, `:1550-1609`)

- Duración 240 ms (`PAGE_TRANSITION_DURATION_MS`), desplazamiento horizontal
  `max(54, width·0.18)` en la dirección del cambio de índice, opacidad
  0→0.72→1 y escala 0.988→1; entrada `easeOutCubic`, salida `easeInQuad`.
  Solo la sección activa está montada (`renderSection` devuelve `null` para
  el resto, `:1468-1469`).

### 5.3 Push de conversación (`ConversationRouteLayer`, `:1611-1636`)

- La conversación entra deslizando desde la derecha
  (`translateX: max(320,width) → 0`) en **140 ms** y cierra en **90 ms**
  (`:748-749`, animación `:2436-2457`, easing easeOutCubic). La lista de
  chats se desplaza en paralelo hacia `-width` (parallax de navegación,
  `:3497-3502`) y queda `pointerEvents='none'`. Al terminar el cierre se
  refresca la bandeja en silencio.
- Sin gesto de "swipe desde el borde para volver" (solo botón atrás). En iOS
  nativo esto lo regala `NavigationStack`.

### 5.4 BottomActionSheet (patrón universal, `:13572-13714`)

Sheet propio (no `ActionSheetIOS`) montado en `Modal transparent`:

- Apertura 260 ms / cierre 280 ms (`CHAT_SHEET_OPEN/CLOSE_DURATION_MS`),
  translateY desde 860 (`CHAT_SHEET_HIDDEN_TRANSLATE_Y`), con opacidad
  1↔0.88 y escala 1↔0.985 sutiles. Dimmer en paralelo.
- Cabecera: handle, título (peso fuerte), subtítulo opcional (1 línea,
  normalmente el nombre del contacto) y botón X circular glass.
- **Drag-to-dismiss** solo desde la región del handle/cabecera: cierra si
  `dy > 70` o velocidad `vy > 0.72`; si no, regresa con spring
  (damping 22, mass 0.8, stiffness 240).
- Teclado: `useKeyboardInset` (`:2087-2114`) infla `paddingBottom` y permite
  `maxHeight: 96%` (88% sin teclado).
- Contenido típico: `SheetActionRow` (`:13716`) = icono en caja 20 pt
  (accent; rojo si `danger`) + título + subtítulo 2 líneas; secciones con
  `sheetSectionDivider` + label mayúscula.
- El cierre es de dos fases (`activeSheet`/`closingSheet` + timer
  `CHAT_SHEET_CLOSE_DURATION_MS + 40`) para animar la salida antes de
  desmontar (`:3053-3070`).

**Equivalente SwiftUI:** `.sheet` con `presentationDetents` +
`presentationBackground(.regularMaterial)` cubre el 90 %; conservar
título/subtítulo/X y las filas icono+título+subtítulo.

### 5.5 Teclado — regla "un solo dueño" (memoria del proyecto)

`AppFrame` (`:1948-2007`) monta **siempre** un único `KeyboardAvoidingView`
(behavior `padding` en iOS) y lo prende/apaga con `enabled={keyboardAvoiding}`
para ceder la propiedad del teclado a una ruta overlay **sin desmontar el
subárbol**. Regla del comentario (`:1991-1996`): *solo puede haber UN avoider
habilitado por ruta visible; dos apilados reaccionan al mismo evento con
frames obsoletos, se compensan doble y dejan una franja entre composer y
teclado.* Aplicaciones concretas:

- `ChatScreen` usa `<AppFrame keyboardAvoiding={!selected}>`: con conversación
  abierta, el `AppFrame` de la conversación es el único dueño (`:3552-3556`).
- `LoginScreen` usa `AppFrame keyboardAvoiding={false}` + su propio KAV local.
- Sheets usan `useKeyboardInset` (listeners will/didShow) en vez de KAV.
- Constantes de composer: `CONVERSATION_COMPOSER_SAFE_BOTTOM = 22` (sin
  teclado) y `CONVERSATION_COMPOSER_KEYBOARD_BOTTOM = 3` (`:758-759`).

En SwiftUI el manejo de teclado es automático, pero la lección persiste para
overlays custom: una sola fuente de inset por ruta visible.

### 5.6 Catálogo de haptics (todos los usos)

| Momento | API | Línea |
|---|---|---|
| Long-press fila de chat (abre "Más acciones") | `Haptics.selectionAsync()` (fallback `Vibration.vibrate(12)`) | `:3103` |
| Entrar en selección múltiple | `selectionAsync` | `:3370` |
| Selección de rango en timeline de Citas (long-press) | `selectionAsync` | `:7062` |
| Aviso de éxito al entrar con notice (p. ej. link de pago creado) | `notificationAsync(Success)` | `:19107` |
| "Pausar/quitar agente y enviar" completado | `notificationAsync(Success)` | `:19545` |
| Long-press burbuja de mensaje (abre acciones) | `impactAsync(Medium)` | `:19556` |
| Pago registrado desde el chat | `notificationAsync(Success)` | `:19912` |
| Cita creada desde el chat | `notificationAsync(Success)` | `:19962` |
| Swipe de respuesta confirmado en burbuja | `impactAsync(Light)` | `:21208` |
| Ciclar velocidad de audio (1×/2×) | `selectionAsync` (fallback vibrate 8) | `:21797` |

### 5.7 Parallax de fondo (detalle "delight")

`useChatWallpaperParallax` (`:2009-2065`): `DeviceMotion` (expo-sensors) a
110 ms; la imagen `chat-wallpaper.webp` se desplaza hasta ±13 pt
(`CHAT_WALLPAPER_PARALLAX_MAX_OFFSET`, padding extra 18) siguiendo la
inclinación del teléfono, con timing 140 ms easeOutCubic. Se usa como fondo de
la conversación (tinte `muted` claro con opacidad 0.82 / `meta` oscuro 0.5).
En iOS nativo: `CMMotionManager` o `UIInterpolatingMotionEffect`.

---

## 6. Inventario por pantalla

### 6.1 Login (`LoginScreen`, `:2132-2206`)

- Logo Ristak (asset `ristak-night-mode-sin-fondo.webp`), kicker "Ristak",
  título "Iniciar sesion", cuerpo "Entra con el correo y la contrasena de tu
  cuenta." (sic, sin acentos en el código actual).
- Inputs: correo (placeholder `correo@negocio.com`, keyboard email, sin
  autocap/autocorrect) y contraseña (secure). Validación local: vacíos →
  *"Escribe tu correo y contrasena."*; regex email → *"Escribe un correo
  válido."*. Botón primario "Entrar" con spinner.
- El login resuelve el tenant vía instalador (`loginWithResolvedTenant`) y
  persiste `baseUrl` + token en SecureStore.

### 6.2 Chats — bandeja (`ChatScreen`, `:2208-3873`)

**Header** (sin barra de navegación estándar):

1. Fila de acciones arriba a la derecha: botón cámara (27 pt) y botón `+`
   "nuevo chat" (37 pt), ambos glass circular.
2. Título grande "Chats" (42/800).
3. Buscador pill (`panelSoft`, radio 19, altura ≥38): icono `Search`,
   placeholder **"Buscar chats"**, botón X para limpiar. Búsqueda con
   debounce 240 ms contra el backend (`:2483-2488`).

**Banda de filtros** (chips horizontales, `ChatFilterBar` `:13152`):

- Presets base (`CHAT_FILTER_LIBRARY`, `:1063-1069`): **Todos** (fijo),
  **No leídos** (con contador "99+"), **Agendados**, **Clientes**, **Leads**,
  **Comentarios** (con separador vertical antes). Chips visibles por defecto:
  `['all','unread','appointments','customers','leads','comments']` (`:718`).
- Chips adicionales agregables: por número de WhatsApp (`phone:<id>`, solo si
  hay >1 número conectado), familias avanzadas (`advanced:channel|origin|
  social|stage|activity:*`) y **filtros condicionales guardados**
  (`custom:<id>`, persisten en `app_config.mobile_chat_custom_filter_presets`
  con reglas all/any sobre segmento, número, canal, origen, red social,
  etapa, actividad, etiquetas y campos personalizados; operadores estilo
  Contactos/Automatizaciones).
- Chip final `+` abre `FilterManagerSheet` (`:13221`): biblioteca con
  agregar/quitar de la fila (persistido en SecureStore
  `ristak.native.chat.visibleFilterIds.v1`) y editor de filtros custom
  (modo lista/editor).
- Tocar chip de número guarda `mobile_chat_selected_whatsapp_phone_id` en
  `app_config` (con rollback + `Alert` "No se guardó el filtro" si falla,
  `:1362-1375`); "Todos"/filtros no numéricos lo regresan a `all`. El filtro
  por número se manda al backend (`businessPhoneNumberId`/`businessPhone`),
  no se filtra localmente.

**Filas especiales** encima de la lista:

- `AssistantChatRow` (`:14901`): fila fija del **"Asistente Personal AI"**
  (subtítulo "Te ayuda dentro de Ristak", meta "Fijo", avatar con icono
  `Bot`), visible si el agente IA está habilitado; abre el chat IA a pantalla
  completa.
- `ArchiveRow` (`:14881`): acceso "Archivados" con contador; toggle de vista
  archivados.
- `ChatSelectionPanel` (`:17608`): en selección múltiple sustituye a los
  chips; muestra contador, "Marcar leídos", menú con "Archivar seleccionados /
  Restaurar seleccionados", "Silenciar seleccionados / Reactivar
  seleccionados", "Seleccionar visibles", y botón limpiar.

**Fila de chat** (`ChatRow` memoizada, `:17702-17770`):

- Altura mínima 86 pt, avatar 58 pt limpio (foto o iniciales "RG" sobre gris
  del tema) + **badge de canal** 22 pt (WhatsApp/IG/Messenger/comentarios/
  email/SMS desde assets rellenos). Nombre (bold solo si hay no leídos) +
  hora a la derecha; debajo, preview de último mensaje con formato WhatsApp
  parseado (negrita/cursiva/tachado/mono) + pill de no leídos ("9+").
- Fecha de fila con **zona horaria del negocio** (`formatChatListDate`,
  `format.ts:378`): hoy → hora exacta "7:47 p.m." (nunca "Hoy"); ayer →
  "Ayer"; <7 días → día de semana ("martes"); después → "04-jul".
- Tap → abre conversación (o toggle en selección). **Long-press (310 ms)** →
  haptic + sheet "Más acciones". **Sin swipe actions** (decisión documentada:
  no reintroducir archivar por swipe).
- Estados de fila: `unread` (fondo suave), `selected`, `archived` (atenuada).

**Comportamiento de datos** (relevante a UX):

- Página de 50 (`CHAT_LIST_PAGE_SIZE`), scroll infinito con
  `onEndReached 0.38` + spinner al pie; refresh silencioso cada 20 s, al
  volver a foreground y al recibir push en foreground
  (`DeviceEventEmitter 'ristak:chat-refresh'`), **fusionando** la primera
  página sobre la cola cargada para no perder scroll (`:2355-2434`).
- Cache de bandeja en memoria por cliente API (`nativeInboxCache`, WeakMap,
  `:730-733`) para pintar al instante al volver a la sección (sin flash
  vacío→spinner→lista).
- Estados: cargando ("Cargando chats..."), error con "Reintentar", vacíos:
  *"Aún no hay chats / Cuando llegue un mensaje de WhatsApp, Messenger o
  Instagram aparecerá aquí."*, *"No hay chats en este filtro / Cambia el
  filtro o busca otro contacto…"*, archivados: *"No hay nada archivado / Los
  chats que archives aparecerán aquí."* Pull-to-refresh en todos.

**Sheet "Más acciones"** (`ChatMoreSheet`, `:13754-13910`), secciones:

- *Agente conversacional* (si el contacto tiene agente): "Continuar agente" /
  "Pausar agente" ("Detiene el agente durante 24 horas."), "Tomar chat"
  ("…deja esta conversación en humano."), "Omitir agente" (danger).
- *Chat*: **Seleccionar** (primera acción por regla), Agendar cita, Registrar
  pagos, Programar mensaje, Agregar etiqueta, Silenciar/Quitar silencio.
- *Bandeja*: Marcar como leído (si hay no leídos), Archivar/Restaurar chat.

**Otros sheets de bandeja:** `ContactTagSheet` (buscar/crear etiqueta y
aplicar), `ScheduleMessageSheet` (texto + fecha/hora con panel de calendario
propio, weekdays "DOM LUN MAR MIÉ JUE VIE SÁB", AM/PM), `ContactPickerSheet`
con dos modos: "Nuevo chat" (buscar contacto y abrir conversación) y "Enviar
media" (tras usar la cámara del header: preview de foto/video, multi-selección
de destinatarios, caption y envío masivo).

### 6.3 Conversación (`NativeConversationScreen`, `:18632-20689`)

**Header** (`:20201-20235`): chevron back (30 pt) · avatar 38 pt con badge de
canal · nombre + detalle (teléfono/canal) — tap abre Info del contacto ·
cápsula glass con 2 acciones divididas: **Agendar cita** (`CalendarDays`) y
**Cobrar** (`CircleDollarSign`), que navegan a la sección correspondiente con
el contacto precargado y bloqueado (`navigateToContactTool`).

**Búsqueda en el chat** (`searchOpen`): barra bajo el header, placeholder
"Buscar en este chat", contador de coincidencias, X cierra.

**Lista de mensajes:** `FlatList` **invertida** con
`maintainVisibleContentPosition {minIndexForVisible:1,
autoscrollToTopThreshold:10}` (anclaje estilo WhatsApp: los mensajes nuevos
solo auto-revelan si ya estás pegado abajo, `:20276-20281`);
`initialNumToRender 20`, límite de hilo 100 mensajes
(`CHAT_CONVERSATION_MESSAGE_LIMIT`), paginación hacia atrás con spinner
"olderMessagesLoader"; poll del hilo cada 7 s
(`CONVERSATION_REFRESH_INTERVAL_MS`). Elementos de lista tipados
(`ConversationListItem`): separador de día (chip centrado: "Hoy"/"Ayer"/día de
semana/fecha corta, `formatConversationDayLabel`), `completionNotice`
(tarjeta de éxito "Pago confirmado"/"Cita agendada" con haptic Success),
`activity` markers (hitos locales: cita creada, pago registrado…), y
burbujas.

**Burbuja** (`NativeMessageBubble` memoizada, `:21136+`):

- Máx. ancho de imagen 252×318; texto con formato WhatsApp; cita de respuesta
  (replyTarget); estado saliente con receipts (`NativeMessageReceipt`:
  sent/delivered/read/pending/failed); mensajes fallidos en rojo con
  "Reintentar" en acciones; mensajes programados con countdown en vivo
  (tick de `scheduledCountdownNow`); destacados (star) con fondo sutil.
- Tipos de adjunto renderizados: imagen, video (`expo-video`), documento,
  **audio con waveform** (barras predefinidas
  `CONVERSATION_AUDIO_WAVE_BAR_HEIGHTS`, velocidades 1×/2×/4× — en móvil tope
  2×, ciclado con haptic), ubicación (tile OpenStreetMap zoom 16, pin
  `#ff5d7e`, 270×124), tarjeta de email (asunto+cuerpo plano), preview de
  link.
- **Swipe-para-responder:** drag horizontal (clamp ±72, entrantes hacia la
  derecha y salientes hacia la izquierda) con glifo `Forward` como cue; commit
  si `|dx| > 38` → haptic Light + fija reply (`:21170-21218`).
- **Long-press:** haptic Medium + `NativeMessageActionSheet` (`:20950`):
  overlay glass a pantalla completa que **re-renderiza la burbuja enfocada**
  con spring (damping 14, stiffness 260), fila flotante de reacciones
  (❤️ 👍 😂 😮 🙏; solo ❤️ para FB/IG; ninguna para email) y dropdown:
  Responder · Copiar · Destacar/Quitar destacado · Reenviar · Reintentar (si
  falló) · Info del mensaje (Alert con canal/estado/hora/error). Para
  programados: Editar programación · Eliminar programación (danger).

**Composer** (`:20408-20478`):

- Fila: **botón de canal** (icono del canal seleccionado; abre
  `NativeComposerChannelSheet` con cada WhatsApp conectado como opción
  separada "WhatsApp · nombre/número", más Messenger/Instagram/etc. solo si
  la ruta está realmente conectada; opciones deshabilitadas muestran Alert
  "Canal no disponible") · botón `+` (sheet Acciones) · input multiline
  (placeholder dinámico) con **botón reloj** para programar el texto escrito
  (aparece solo con texto y sin adjuntos) · botón cámara (solo sin contenido)
  · **botón morph mic/enviar**: sin contenido = mic (graba nota de voz), con
  contenido = flecha enviar en círculo accent.
- Tray de borradores de adjuntos (límite 4, `CONVERSATION_ATTACHMENT_LIMIT`),
  con índice numerado, X por adjunto y pie "N archivos listos · Agrega texto
  o envía directo."
- Barra de respuesta ("Respondiendo a ti/<nombre>") con preview y X.
- **Grabación de voz:** panel dedicado con waveform en vivo por metering,
  pausa/reanudar, cancelar y enviar; luego panel de **preview** con
  reproducción antes de enviar.
- Preview de link de pago pendiente (draft que llega desde Pagos).
- Límites de adjuntos: media 16 MB, documentos 20 MB, video 25 MB, video de
  cámara máx. 60 s (`:814-817`).

**Sheet "Acciones"** (`NativeConversationAttachmentSheet`, `:20756-20889`):
sección *Agente conversacional* (por agente: Continuar/Pausar/Tomar chat/
Omitir) · *Adjuntos*: Cámara, Fotos y videos, Documento, Ubicación, Buscar en
este chat · *Herramientas*: Plantillas, Enviar CLABE, Agendar cita, Registrar
pagos, Programar mensaje, Agregar etiqueta, Más acciones.

**Flujo de interrupción del agente** (`NativeManualAgentSendSheet`,
`:20892-20947`): si el agente IA está activo y el humano envía, aparece sheet
"Agente activo en este chat / Elige qué hacer antes de enviar" con: "Pausar
24h y enviar", "Quitar del agente y enviar" (danger) y "Cancelar".

**Sheets de herramientas en el chat:** Plantillas (lista con estado Meta:
Aprobada/En revisión/Rechazada/Bloqueada; bloqueadas no enviables), CLABE
(cuentas guardadas + formulario alias/CLABE/banco/titular; envía como texto),
Registrar pago (monto/concepto/método), Agendar cita (draft rápido), Programar
mensaje (igual que bandeja, con modo edición).

### 6.4 Info del contacto (`NativeContactDetailScreen`, `:17843-18396`)

Pantalla completa (no sheet) con fondo full-bleed
(`CONTACT_INFO_THEME.conversationBg`) que cubre el status bar; panels con
back propio (`ContactInfoPanel = main | payments | appointments | archives |
journey | agent_history`):

- **Main:** avatar grande con aro separado del clipping · nombre editable ·
  teléfono/estado (badge) · selector **"CONTACTANDO DESDE"** (sheet con
  "Automático" + cada número WhatsApp; guarda
  `preferred_whatsapp_phone_number_id`; elegir el número que ya mostraba
  automático también lo fija) · tarjetas métricas **Total** (pagos, "N pagos",
  acción "Ver") y **Citas** ("N activas") · fila resumen **Archivos del
  chat** · secciones en contenedores elevados con headings en mayúsculas:
  **DATOS PRINCIPALES** (número editable con lápiz, email, etc.), **ORIGEN Y
  CONVERSIÓN** (fuente, "Convirtió" con cita), fila **Viaje de cliente**
  ("N eventos · De más nuevo a más viejo"), **SEGUIMIENTO** ("Próxima cita"),
  **HISTORIAL DEL AGENTE** (último hito), **CAMPOS PERSONALIZADOS** (catálogo
  completo agrupado por carpeta, editable por campo).
- **Pagos totales / Citas:** listas con filas y detalle propio ("Detalle de
  pago", "Detalle de cita"). Vacíos: "Aún no hay pagos/citas guardados para
  este contacto."
- **Archivos del chat:** tabs `Fotos y videos` (grid) · `Documentos` ·
  `Enlaces` (filas tocables) con contadores.
- **Viaje de cliente:** timeline conectado (línea vertical entre iconos)
  dentro de contenedor elevado, header "Recorrido del contacto"; aplica las
  reglas de journey del escritorio (filtra salientes, agrupa por día de la
  zona del negocio, oculta WhatsApp directo post-primer-pago sin atribución).
  Vacío: "Sin actividad todavía / Aún no hay hitos guardados…".
- **Historial del agente:** tarjetas título/subtítulo/fecha. Vacío: "Aún no
  hay metas concretadas por el agente."

### 6.5 Asistente Personal AI (`AssistantConversationScreen`, `:15198+`)

Chat a pantalla completa contra el agente IA de la app (id local
`ristak-ai-agent-mobile-chat`): burbujas propias, tray de adjuntos (imagen /
video / pdf / texto / archivo; límites 8 MB directo, 16 MB total, texto
1.5 MB / 18.000 chars, `:752-755`), sheet para elegir adjunto, dictado de voz
con estados `idle | recording | paused | processing`. Manda contexto de vista
("App móvil · Chats · Asistente Personal AI"). No agenda ni cobra por sí solo
(guardrail en el contexto, `:14947-14950`).

### 6.6 Citas (`CalendarSection`, `:7115-8358`)

**Header original de `/movil`:** pastilla de periodo con chevron-izquierda +
label (sube de nivel: día→mes→año→años) · cápsula glass con
**"Hoy"** (quick return) + icono calendario (selector de calendarios) + `+`
(nueva cita) · **título grande del mes** (39/900, capitalizado) que se
desliza **sincronizado con el swipe de la grilla** (pager de 3 páginas
-1/0/+1, `MONTH_PAGER_OFFSETS`).

**Vistas** (`CalendarViewMode = day | week | month | year | years`):

- **Mes:** grilla amplia (celda 39 pt de alto, weekday row 28, letras
  "D L M M J V S"), dots de eventos, bolita grande de día seleccionado;
  swipe horizontal entre meses (commit al 18 % del ancho o 56 px mínimo,
  `:834-836`); debajo, header de agenda "‹fecha› / N citas|Sin citas" y lista
  de `CalendarEventCard` compactas.
- **Día/Semana:** timeline de 24 h (54 pt/hora), tarjetas de evento con campo
  suave y borde tenue (sin franja de color); **long-press 380 ms** sobre un
  horario dispara haptic, bloquea el scroll y permite estirar el rango
  verticalmente para crear cita en ese rango (tolerancias: cancela con
  movimiento >12 px horizontal / >30 px vertical antes del delay; tap simple
  tolera 10 px; ancla del dedo con offset 18 px, `:841-845`).
- **Año:** 12 meses en grilla + "Próximas citas / N en este rango".
- **Años:** grilla de 12 años.

**Sheets:**

- `CalendarPickerSheet`: lista de calendarios con color.
- `AppointmentContactPickerSheet`: buscar contacto para la cita (sin icono de
  enviar mensaje — la acción es agendar); permite crear contacto nuevo.
- `CalendarEventDetailsSheet`: detalle con editar / eliminar (busy states).
- `AppointmentFormSheet` (`:9168`): modos **create/edit**; agenda **"Por
  defecto"** (slots: chips de fechas disponibles con span 140 px, horarios
  libres, invitados, notas, CTA crear — sin campos de fecha/hora/duración/
  zona/dirección) vs **"Personalizado"** (ruedas internas de día/mes/año,
  hora/minutos/AM-PM — horas 1–12, minutos de 5 en 5 — y duración horas 0–12
  + minutos 0–59; altura de opción de rueda 64 pt). Selector de calendario
  como **subvista del mismo sheet** (nunca modal encima de modal — iOS los
  bloquea). Invitados antes de Notas; se guardan serializados en notas con el
  bloque "Invitados:" (`:7012-7058`) hasta tener campo estructurado.

**Datos/UX:** todas las agrupaciones usan `account_timezone` (nunca la del
teléfono); fechas/horas se convierten a UTC con esa zona. Caches en
SecureStore: calendario seleccionado, bootstrap y eventos
(`ristak.native.calendar.*`, `:818-820`); timeout de requests 8 s. Estados:
"Cargando citas...", `CalendarErrorState` con retry, vacíos "No hay citas este
día" / "No hay citas próximas / Cambia de calendario o crea una cita nueva."

### 6.7 Pagos (`PaymentsSection`, `:3875-4517`)

**Vista selector** (título "Elige cómo quieres pagar", 38/900):

- Tarjetas de elección (`PaymentChoiceCard`): **Registrar pago único** (copy
  cambia si `offlineOnly`), **Planes de pago** (solo si
  `canUsePaymentPlans`), **Suscripción** (solo si `canUseSubscriptions`;
  "Cobros recurrentes con Stripe, Conekta o Mercado Pago."), **Precios
  Guardados** (CRUD de productos/precios).
- Si llega contacto desde el chat: tarjeta fija "Cobro para ‹nombre›" con
  avatar (contacto bloqueado).
- Panel **"Pagos"** recientes: chips de periodo `Hoy / 7d / 30d / 90d /
  Personalizado` (separador antes de custom; el custom abre sheet "Fecha
  personalizada" con inputs YYYY-MM-DD inicio/fin, botones "Aplicar rango" /
  "Cancelar"); lista de pagos (monto formateado con moneda de cuenta,
  contacto, fecha con zona de negocio, "‹Método› · ‹Estado›"); estados
  cargando/error/refresh inline/vacío ("No hay pagos recibidos en este
  periodo.").

**Flujos** (`PaymentView = select | single | partial | subscription |
products`), formulario `PaymentFormView` (`:4961-6429`): paso a paso con
header "Atrás" + step label; bloque **Cliente** (buscar contacto o manual:
nombre/correo/teléfono); bloque **Cobro** (tipo de cobro, producto/precio
guardado o precio custom, monto, concepto, descripción, impuestos con
desglose Total); bloque de método (offline: efectivo/transferencia/depósito;
link de pago por pasarela con MSI y validaciones de mínimos; tarjeta guardada
del contacto); **planes**: "Diferimiento" con frecuencia, Pago 1
(inmediato/programado + método), pagos restantes editables, "Agregar pago",
"Distribuir", y validación de cuadre (*"No cuadran las parcialidades: faltan/
sobran $X"*). Validaciones como Alerts en español (`:5366-5877`: "Falta el
monto", "Falta el cliente", "Falta tarjeta guardada", "Frecuencia no
soportada", "MSI no disponible", "Cobro en proceso", etc.).
Al crear link de pago puede saltar al chat con draft (`onOpenChatDraft`).
Regla: si la moneda de cuenta no resuelve, **bloquea** la creación en vez de
registrar dinero mal etiquetado (README `mobile/README.md:38-44`).

### 6.8 Analíticas (`AnalyticsSection`, `:10575-11247`)

- Header: eyebrow "Ristak" + título "Analíticas" (42/900) + **toggle de
  periodo** (soft glass, chevron) que abre menú inline de opciones
  `30d / 60d / 180d / year / custom` (custom abre sheet de rango
  YYYY-MM-DD; el rango elegido se muestra inline bajo el título).
- **Grid de 8 KPI cards** (icono tonal, título, valor, delta "±X% vs antes"
  en pos/neg).
- **Panel Gráfica:** label "Gráfica" + título del view; chips horizontales de
  5 vistas (`revenue-spend`, `visitors-leads`, `leads-appointments`,
  `appointments-attendances`, `attendances-sales`); segmented "Todos / Al
  registro / Anuncios" (scope financiero, solo en revenue-spend); leyenda de
  2 series con dots de color; `AnalyticsDualLineChart` (SVG dual-line custom,
  `:10471`). Vacío: "Sin datos para este periodo."
- **Panel Embudo:** "Conversiones" + pill de % total; segmented de scope;
  filas con icono (Users/Target/CalendarDays/CheckCircle2/DollarSign), valor,
  barra de progreso y "X% desde el paso anterior".
- **Panel Origen:** "Fuentes" + pill de total; chips `traffic / leads /
  appointments / conversions`; top 8 filas con barra coloreada. Vacío: "Sin
  origen detectado en este periodo."
- **Panel WhatsApp "Origen por número"** (solo con varios números): filas por
  número con "N personas", barra y estado.
- Pull-to-refresh global; errores inline con "Reintentar". Todo formateado
  con `account_currency` + `account_timezone`.

### 6.9 Ajustes (`SettingsScreen`, `:11428-12262`)

- Header: kicker "Ristak" + título 40/900 ("Ajustes" o el panel activo) y, en
  panel, botón glass "‹ Ajustes" para volver (navegación in-place, no push).
- **Lista principal** (`renderMainList`, `:11827-11887`) — filas icono
  tonal + título + descripción + meta + chevron:

| id | Título | Descripción | Meta dinámica |
|---|---|---|---|
| numbers | Números de WhatsApp | Principal y bandejas por remitente. | N / "Revisar" |
| templates | Plantillas | Crear y revisar estados de Meta. | "N guardadas" |
| agent | Asistente Personal AI | Chat fijo y sugerencias. | Activo/Apagado/"Sin OpenAI" |
| chats | Lista de chat | Orden, archivados y vista previa. | Recientes/No leídas |
| custom-fields | Campos personalizados | Datos visibles en cada contacto. | N/"Todos" |
| appearance | Apariencia | Claro, noche, sistema u horario. | p.ej. "Sistema: Noche" |
| privacy | Privacidad | Controla vistos de WhatsApp, Messenger e Instagram. | "Vistos activos/apagados" |
| notifications | Notificaciones | Mensajes, citas, sonido y vibración. | Activo/Bloqueado/Activar |
| — | **Cerrar sesión** (rojo) | Salir de este dispositivo. | |

- **Números:** tarjeta de acción "Números de WhatsApp" con "Actualizar";
  selector de bandeja por remitente; estado por número ("Principal", "QR
  listo", "Respaldo QR", "No disponible"). Vacío: "Todavía no hay números de
  WhatsApp conectados."
- **Plantillas:** estados Meta con labels es-MX; "N necesitan revisión.".
- **Agente (IA):** conectar token OpenAI (input secure "Pega tu API key de
  OpenAI (sk-...)"), panel "Descripción del negocio" con **dictado por voz**
  (expo-audio + `/api/ai-agent/transcribe`; estados Dictar/Detener/Procesando,
  mensajes "Grabando... toca detener cuando termines.", "Transcribiendo
  audio..."), botón Guardar; toggles "Mostrar como primer chat" y "Sugerir
  respuestas".
- **Lista de chats:** orden (Recientes/No leídas), toggles "Mostrar
  archivados", "Vista previa", "Indicadores de no leídos" (claves
  `mobile_chat_*` en `app_config`).
- **Campos personalizados:** informativo — "El chat móvil muestra el catálogo
  completo, agrupado por carpeta…".
- **Apariencia:** opciones de tema con título/subtítulo y hint "Ahorita la
  app se ve en modo … y el fondo nativo del celular ya sigue esa
  preferencia."
- **Privacidad:** toggle "Marcar mensajes como leídos o vistos" (clave
  `chat_send_read_receipts_enabled`).
- **Notificaciones:** estado de permiso ("Activo/Bloqueado/No soportado/
  Activar") + botón Activar/Actualizar (registra device en
  `/api/push/mobile-devices`); toggles por categoría: "Mensajes del chat",
  "Citas agendadas" (+ sub-lista "Calendarios con alertas"), "Citas
  confirmadas", "Pagos"; tarjeta "Sonido y vibración" con "Timbre de
  notificación" y "Vibración de notificación" (claves `*_push_notifications_
  enabled`, `push_notification_sound_enabled`, etc. en `user_config`).

**Deep links de push** (`getPhoneSectionFromNotification`, `:646-656`): la
notificación trae `url`/`category`/`contactId`; se enruta a
calendar/payments/analytics/settings/chat (chat abre el hilo del
`contactId`). En foreground, el push emite `ristak:chat-refresh`.

---

## 7. Formato de datos (reglas de `format.ts`)

- Zona por defecto `America/Mexico_City`; siempre `resolveBusinessTimezone`.
- Locale **es-MX** en todos los `Intl` (fechas y moneda).
- Meses cortos custom: `ene feb mar abr may jun jul ago sep oct nov dic`.
- `formatChatListDate` (bandeja) y `formatConversationDayLabel` (separadores):
  descritos arriba; el separador agrega año solo si difiere del actual.
- `formatMessageTime`: `hour numeric, minute 2-digit` (→ "7:47 p.m.").
- `formatCurrency`: `Intl` currency es-MX, máx. 2 decimales; compactos
  (`formatCompactNumber/Currency`) con `notation: 'compact'`, 1 decimal.
  `normalizeCurrencyCode` valida ISO-4217 con fallback MXN.
- `formatPaymentDate`: date-only → "5 jul"; datetime → "5 jul 7:47 p.m.".
- `getPaymentMethodLabel` / `getPaymentStatusLabel`: catálogos es-MX
  (Tarjeta, Transferencia, Efectivo, Cheque, PayPal, Stripe, Conekta,
  Mercado Pago, CLIP, Rebill, Link / Pagado, Parcial, Reembolsado, Fallido,
  Pendiente, Enviado, Borrador).
- `formatRoas`: "1.85x".

---

## 8. Persistencia local (SecureStore — `storage.ts`)

| Clave | Contenido |
|---|---|
| `ristak.native.apiBaseUrl.v1` / `ristak.native.authToken.v1` | sesión |
| `ristak.native.chat.visibleFilterIds.v1` | chips visibles |
| `ristak.native.chat.archivedIds.v1` | **chats archivados (solo local)** |
| `ristak.native.chat.mutedIds.v1` | **chats silenciados (solo local)** |
| `ristak.native.calendar.selectedCalendarId.v1` | calendario elegido |
| `ristak.native.calendar.bootstrapCache.v1` / `eventsCache.v1` | caches de citas |

⚠️ Archivar/silenciar **no viaja al backend**: es estado por dispositivo. En
iOS nativo conviene decidir si se replica igual (paridad) o se propone
sincronización (ver Gaps).

---

## 9. Deuda UX / asperezas que el nativo puede mejorar (iPhone)

1. **Sin gesto de regreso por borde** en conversación/Info del contacto/
   paneles de Ajustes; todo depende de botones. `NavigationStack` lo da
   gratis.
2. **Dynamic Type deshabilitado** en Info del contacto
   (`allowFontScaling={false}`) y escala compacta 0.78 a mano; accesibilidad
   pobre. iOS nativo debe soportar Dynamic Type con layouts que aguanten.
3. **Retema en caliente frágil** (mutación global de `COLORS` + regeneración
   de StyleSheet + remount con `resetKey`); en SwiftUI es declarativo.
4. **Safe areas hardcodeadas** (`DEFAULT_IOS_TOP_SAFE_AREA = 47`,
   `DEFAULT_IOS_BOTTOM_SAFE_AREA = 34`, `:356-357`) con lectura tardía del
   StatusBarManager; nativo usa safe area real.
5. **Selectores de fecha caseros**: rango custom de Analíticas/Pagos se
   escribe a mano "YYYY-MM-DD" en TextInputs; ruedas de cita propias. Nativo:
   `DatePicker`/calendario de sistema con la misma jerarquía visual.
6. **Polling** (bandeja 20 s, hilo 7 s) sin realtime; parpadeos mitigados con
   merges manuales. Nativo puede considerar websockets/SSE si el backend lo
   ofrece, o al menos igualar el merge sin flash.
7. **Alerts genéricos** (`Alert.alert`) para muchos errores/confirmaciones;
   candidatos a estados inline o toasts nativos.
8. **Selección múltiple no disponible dentro de la conversación** ("La
   selección múltiple se maneja desde la lista de chats.", `:20595`).
9. **Búsqueda en chat filtra solo los ~100 mensajes cargados** (client-side
   sobre `filteredMessages`), sin búsqueda de servidor.
10. Lista de chats **remonta al cambiar de sección** (cache WeakMap como
    parche); en SwiftUI el estado por tab persiste naturalmente.
11. Íconos mezclan 3 familias (Lucide, FontAwesome, Ionicons); nativo debería
    unificar en SF Symbols manteniendo el trazo fino.
12. **Reacciones**: la UI permite reaccionar pero el catálogo depende del
    transporte con reglas hardcodeadas; revisar contra el backend real.
13. Sheets custom con física propia; en nativo usar detents del sistema y
    conservar la jerarquía título/subtítulo/acciones.
14. Wallpaper con sensor de movimiento corre siempre que la conversación está
    activa: en nativo, respetar Low Power Mode / Reduce Motion.

## 10. Lo que una capa iPad necesitaría (nunca construido en RN)

La app RN es **solo teléfono** (una columna, dock inferior, sheets de borde
inferior). Para iPad/universal habría que diseñar desde cero:

1. **Split view para Chats**: lista (sidebar) + conversación en dos columnas
   (`NavigationSplitView`); hoy la conversación es una capa que tapa la
   lista. Info del contacto como tercera columna o inspector.
2. **Dock → sidebar/tab bar adaptativa**: en iPad el dock flotante de 5
   iconos debería volverse `TabView` con sidebar adaptable (iOS 18+) o
   sidebar de secciones; conservar badge de chats.
3. **Sheets → popovers/inspectores** según contexto (acciones de fila,
   selector de canal, filtros) en regular width.
4. **Citas**: aprovechar ancho para vista semana real de varias columnas
   (hoy "semana" reutiliza el timeline de día); month + agenda lado a lado.
5. **Analíticas**: grid de KPIs de 4 columnas, gráfica + embudo lado a lado.
6. **Pagos**: formulario multi-paso como two-pane (lista de pasos +
   contenido) en vez de scroll único.
7. **Teclado externo / atajos** (⌘N nuevo chat, ⌘F buscar…), hover states y
   pointer effects — inexistentes en RN.
8. **Multiventana / Stage Manager y drag & drop de adjuntos** (arrastrar
   imagen al composer), soportables solo en nativo.
9. Reconsiderar el patrón "navegar a sección con contacto precargado"
   (`navigateToContactTool`): en iPad puede ser un modal/inspector sin sacar
   al usuario de Chats.

---

## 11. Gaps / riesgos para iOS nativo (y OPEN QUESTIONS)

1. **Archivado/silenciado solo local** (SecureStore): no hay endpoint para
   sincronizarlo. Riesgo de divergencia iPhone↔iPad↔/movil. OPEN QUESTION:
   ¿se agrega clave en `app_config`/contacto o se acepta estado por
   dispositivo?
2. **Mensajes destacados (`starredMessageIds`) y reacciones**: gestionados en
   estado local del hilo; confirmar persistencia real de reacciones por canal
   en el backend antes de diseñar la UI definitiva.
3. **Invitados de cita serializados en notas** (bloque "Invitados:") — hack
   documentado hasta tener campo estructurado. El parser nativo debe replicar
   el formato exacto (`- Nombre: contacto` por línea, `:7012-7053`).
4. **Slots/bloqueos avanzados y Round Robin** del modal web de citas: brecha
   pendiente reconocida en `docs/MOBILE_APP.md` (§Página de Citas nativa).
5. **Sin realtime**: todo es polling + push foreground. OPEN QUESTION: ¿el
   backend expone algún canal de eventos utilizable por iOS?
6. **Identidad de bundle**: RN Android usa `com.ristak.android` side-by-side; la
   app SwiftUI Apple de `ios/app` usa la identidad oficial de tienda
   `com.ristak.app`, alineada con el topic APNs default.
7. **Filtros custom**: la evaluación de presets (`custom:*`) corre
   client-side sobre la página cargada (excepto el filtro por número, que sí
   va al backend). Con paginación de 50, un filtro custom puede verse vacío
   aunque haya matches más atrás. Replicar limitación o pedir soporte de
   backend (OPEN QUESTION).
8. **Tope de 100 mensajes** por hilo con paginación hacia atrás; confirmar
   contrato exacto de paginación del journey para el scroll infinito nativo.
9. **Moneda / zona horaria**: reglas duras — nunca usar la zona del dispositivo
   ni moneda hardcodeada; si `account_currency` no resuelve, **bloquear**
   creación de pagos.
10. **Textos con ortografía inconsistente** en RN ("Iniciar sesion",
    "contrasena", "Sesion" sin acentos en login/menú de sesión). OPEN
    QUESTION: ¿corregir acentos en nativo o mantener paridad literal?
    (Recomendado: corregir; el resto de la app sí usa acentos.)
11. **El header genérico `SectionHeader`** ("Ristak Phone" + menú "…" con
    Cancelar/Cambiar app/Salir, `:1908-1946`) ya casi no se usa (cada sección
    pinta su propio header; logout vive en Ajustes). No copiarlo como patrón.
