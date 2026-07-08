# 16 — Liquid Glass + SwiftUI moderno (iOS 26): guía definitiva de implementación

> Spec de investigación para la app nativa SwiftUI de Ristak (iPhone/iPad universal,
> iOS 26, Xcode 26). **Este documento es la referencia canónica de APIs de Liquid Glass
> y SwiftUI moderno para los agentes Swift: ninguna firma de esta guía debe adivinarse.**
> Todo lo listado como "verificado" proviene de la documentación oficial de Apple
> (endpoints JSON de developer.apple.com, consultados 2026-07-07). Lo no confirmado
> está marcado **UNVERIFIED** u **OPEN QUESTION**.
>
> Fuentes principales (todas verificadas contra el contenido real de la página):
> - https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
> - https://developer.apple.com/documentation/technologyoverviews/liquid-glass
> - https://developer.apple.com/documentation/technologyoverviews/swiftui
> - https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views
> - https://developer.apple.com/documentation/swiftui/landmarks-building-an-app-with-liquid-glass
> - https://developer.apple.com/design/human-interface-guidelines/materials (sección Liquid Glass, changelog 2025-09-09)
> - Páginas de API individuales citadas en cada sección.
> - Videos WWDC25 de referencia (no transcritos aquí): "Meet Liquid Glass" (wwdc2025/219),
>   "Get to know the new design system" (wwdc2025/356), "Build a SwiftUI app with the new design" (wwdc2025/323).

---

## 1. Resumen ejecutivo

- **Liquid Glass** es el material dinámico de iOS/iPadOS/macOS/tvOS/watchOS 26: combina
  propiedades ópticas de vidrio (blur, refracción, reflejo de color/luz) con fluidez
  (morphing, reacción al tacto). Forma **una capa funcional distinta** para controles y
  navegación que **flota sobre la capa de contenido**.
- Al **recompilar con el SDK de iOS 26**, todos los componentes estándar (bars, sheets,
  popovers, controles, listas) adoptan Liquid Glass **automáticamente**. La adopción
  explícita solo hace falta para: efectos glass en vistas custom, minimización del tab bar,
  accesorio inferior del TabView, background extension effect, estilos de scroll edge en
  barras custom, tab de búsqueda semántica y formas concéntricas.
- Regla de oro de diseño: **glass solo en la capa flotante de navegación/controles, nunca
  en la capa de contenido; nada de glass sobre glass; usarlo con moderación**.
- El "kill switch" temporal es la clave Info.plist `UIDesignRequiresCompatibility = YES`
  (se ignora a partir de iOS 27) — **no usarla en una app nueva**.
- Accesibilidad: los ajustes del usuario (Reducir transparencia, Reducir movimiento,
  Aumentar contraste, "apariencia preferida de Liquid Glass" en Ajustes) modifican o
  eliminan los efectos **automáticamente en componentes del sistema**; en vistas custom hay
  que leer `\.accessibilityReduceTransparency` / `\.accessibilityReduceMotion` y dar fallback.

---

## 2. Principios de diseño de Liquid Glass (HIG)

Fuente: HIG › Materials (sección "Liquid Glass") + Adopting Liquid Glass.

### 2.1 Modelo de capas

1. **Capa de contenido** (abajo): el contenido del app — listas, mensajes, tablas, fondos.
   Aquí van los **materiales estándar** (`Material.ultraThin/.thin/.regular/.thick`) si se
   necesita diferenciación visual. **Prohibido usar Liquid Glass aquí** (HIG: "Don't use
   Liquid Glass in the content layer"). Excepción: controles del contenido con elemento
   interactivo transitorio (el knob de un `Slider`/`Toggle` se vuelve glass al tocarlo —
   lo hace el sistema solo).
2. **Capa funcional flotante** (arriba): tab bars, sidebars, toolbars, sheets, popovers,
   menús, controles. Esta capa ES Liquid Glass. El contenido hace scroll y "se asoma"
   por debajo de estos elementos.

### 2.2 Reglas duras

- **Usar frameworks del sistema**: los componentes estándar de SwiftUI adoptan el material
  y sus adaptaciones (solape de elementos, focus, ajustes de accesibilidad) sin código.
- **Quitar fondos custom** en controles y elementos de navegación (`NavigationStack`,
  `NavigationSplitView`, `toolbar(content:)`): un fondo propio interfiere con el glass y el
  scroll edge effect del sistema.
- **No abusar del efecto**: aplicar `glassEffect` a controles custom "sparingly"; limitarlo
  a los elementos funcionales más importantes. Demasiado glass distrae del contenido.
- **Evitar glass sobre glass**: no apilar ni amontonar elementos Liquid Glass; respetar
  métricas de espaciado estándar ("Check for crowding or overlapping of controls").
- **Color con criterio**: poco color en controles/navegación para mantener legibilidad; si se
  aplica, usar colores del sistema o colores custom con variantes light/dark **y** variante de
  contraste aumentado.
- **Negrita/jerarquía**: establecer jerarquía de navegación clara y separada del contenido.
- **Legibilidad primero**: cuando el contenido scrollea bajo controles, confiar en el
  **scroll edge effect** (las barras del sistema lo traen por defecto; ver §6).

### 2.3 Variantes del material: `regular` vs `clear`

- **`.regular`** (default): hace blur y ajusta la luminosidad del fondo para mantener
  legibilidad del texto. Con scroll edge effects para reforzar. Es la variante de casi todos
  los componentes del sistema. Usarla cuando hay bastante texto (alerts, sidebars, popovers)
  o cuando el fondo puede comprometer la legibilidad. **Para un CRM (texto denso) es la
  variante correcta prácticamente siempre.**
- **`.clear`**: muy translúcida; solo para componentes que flotan sobre fondos visualmente
  ricos (fotos/video), p. ej. controles sobre media. Si el fondo es claro, añadir una capa
  de atenuación oscura de **35 % de opacidad** detrás del componente; si el fondo ya es
  oscuro (o usas controles AVKit que traen su propio dimming), no hace falta.
- **`.identity`**: desactiva el efecto (el contenido queda como si no hubiera glass) — útil
  para condicionales de accesibilidad.

### 2.4 Cuándo NO usar glass (checklist de rechazo)

- Fondos de pantalla/celdas/cards del contenido → usar `Material` estándar o colores.
- Elementos estáticos no interactivos del contenido.
- Más de un "cluster" de controles glass custom compitiendo en pantalla.
- Reimplementar botones/barras que ya existen como componente del sistema
  (usar `.buttonStyle(.glass)` en vez de un `glassEffect` manual, toolbar del sistema en
  vez de una barra propia, etc.).

---

## 3. Gratis al compilar con el SDK de iOS 26 vs adopción explícita

Fuente: Adopting Liquid Glass ("See your app with Liquid Glass" + secciones).

### 3.1 Automático (solo recompilar con Xcode 26 / SDK iOS 26)

| Área | Qué cambia solo |
|---|---|
| Bars | Tab bars y toolbars flotan en glass; navigation bar translúcida; scroll edge effect en barras del sistema |
| Controles | `Button`, `Toggle`, `Slider`, `Stepper`, `Picker`, `TextField` con nueva forma/tamaños; knobs se vuelven glass al interactuar; formas más redondeadas concéntricas al hardware |
| Sheets | Mayor radio de esquina; half-sheets con inset respecto al borde de pantalla (el contenido se asoma); al expandir a full-height se vuelven más opacas |
| Popovers/menús | Adoptan glass; menús con iconos para acciones estándar (según selector) |
| Action sheets | `confirmationDialog` se origina desde el elemento que la dispara (anclada), no desde el borde inferior; permite interactuar con el resto de la UI |
| Listas/forms | Mayor row height y padding; secciones con más radio; headers de sección en **Title Case** (ya no TODO MAYÚSCULAS) |
| Búsqueda | El campo se desliza hacia arriba con el teclado al enfocarlo |
| Split views | Sidebar/inspector flotantes en glass |

### 3.2 Requiere adopción explícita

| API | Para qué |
|---|---|
| `glassEffect(_:in:)` + `GlassEffectContainer` | Glass en vistas custom (§4) |
| `buttonStyle(.glass)` / `.glassProminent` / `.glass(_:)` | Botones glass sin efecto manual (§5) |
| `tabBarMinimizeBehavior(_:)` | Minimizar tab bar al hacer scroll (iPhone) (§8.4) |
| `tabViewBottomAccessory(content:)` | Accesorio inferior tipo mini-player (§8.5) |
| `Tab(role: .search)` | Tab de búsqueda semántica separada al trailing (§8.3) |
| `tabViewStyle(.sidebarAdaptable)` | Tab bar que se adapta a sidebar en iPad (§8.2) |
| `backgroundExtensionEffect()` | Extender contenido bajo sidebar/inspector (§7) |
| `scrollEdgeEffectStyle(_:for:)` / `scrollEdgeEffectHidden(_:for:)` / `safeAreaBar(...)` | Efecto de borde en barras/overlays custom (§6) |
| `searchToolbarBehavior(_:)` | Búsqueda minimizada como botón en el bottom toolbar de iPhone (§10.3) |
| `ToolbarSpacer` / agrupación de toolbar items | Separar grupos de acciones en el toolbar (§11.2) |
| `ConcentricRectangle` / `.rect(corners:isUniform:)` | Esquinas concéntricas con el contenedor/hardware (§12.4) |
| Icon Composer | App icon por capas (light/dark/clear/tinted) — fuera del código Swift |

### 3.3 Modo compatibilidad (escape temporal)

Clave Info.plist **`UIDesignRequiresCompatibility`** (Boolean, iOS 26/iPadOS 26/macOS 26/tvOS 26):

- `YES` → la app se renderiza como con SDKs anteriores (sin rediseño).
- `NO` o ausente → diseño nuevo (default al linkear el SDK 26).
- **Se ignora al compilar contra iOS 27+.** Apple lo marca como "Warning: Temporarily use
  this key while reviewing and refining your app's UI".
- Para Ristak iOS (app nueva): **no** incluir esta clave.

---

## 4. APIs de Liquid Glass en vistas custom (firmas exactas)

Disponibilidad de todo este bloque: **iOS 26.0+, iPadOS 26.0+, Mac Catalyst 26.0+, macOS 26.0+, tvOS 26.0+, watchOS 26.0+** salvo nota.

### 4.1 `glassEffect(_:in:)` — View modifier

```swift
nonisolated func glassEffect(
    _ glass: Glass = .regular,
    in shape: some Shape = DefaultGlassEffectShape()
) -> some View
```

- Renderiza una forma anclada **detrás** de la vista con material Liquid Glass y aplica los
  efectos de foreground de Liquid Glass **sobre** la vista.
- Forma por defecto: **`Capsule`** (`DefaultGlassEffectShape`). Variante por defecto: `.regular`.
- El material se ancla a los **bounds** de la vista (incluye el `padding` aplicado antes).
- **Orden de modifiers**: aplicar `glassEffect` DESPUÉS de los modifiers que afectan a la
  apariencia de la vista (el modifier captura el contenido para enviarlo al container).

```swift
// Básico (capsule + regular)
Text("Hola").font(.title).padding().glassEffect()

// Forma custom
Text("Hola").padding().glassEffect(in: .rect(cornerRadius: 16.0))

// Tinte + interactividad (reacciona a touch/pointer como los botones .glass)
Text("Hola").padding().glassEffect(.regular.tint(.orange).interactive())
```

### 4.2 `Glass` — struct de configuración

```swift
struct Glass
```

| Miembro | Firma | Notas |
|---|---|---|
| `.regular` | `static var regular: Glass` | Variante estándar (blur + luminosidad, legible) |
| `.clear` | `static var clear: Glass` | Muy translúcida; solo sobre fondos ricos; considerar dimming 35 % (§2.3) |
| `.identity` | `static var identity: Glass` | Sin efecto — el contenido queda intacto (útil como fallback de accesibilidad) |
| `.tint(_:)` | `func tint(_ color: Color?) -> Glass` | Tinte para sugerir prominencia |
| `.interactive(_:)` | `func interactive(_ isEnabled: Bool = true) -> Glass` | Reacciona a touch/pointer en tiempo real |

### 4.3 `GlassEffectContainer`

```swift
@MainActor @preconcurrency
struct GlassEffectContainer<Content> where Content : View

init(spacing: CGFloat?, content: () -> Content)
```

- **Obligatorio para rendimiento** cuando hay varias vistas con `glassEffect`: combina las
  formas en un solo render y permite que se fusionen/morfeen entre sí.
- `spacing`: a mayor spacing, antes empiezan a fundirse las formas al acercarse. Si el
  spacing del container es mayor que el spacing del `HStack`/`VStack` interior, los efectos
  se funden **en reposo**.
- Regla de Apple: "Creating too many Liquid Glass effect containers and applying too many
  effects to views outside of containers can degrade performance. Limit the use of Liquid
  Glass effects onscreen at the same time."

```swift
GlassEffectContainer(spacing: 40.0) {
    HStack(spacing: 40.0) {
        Image(systemName: "scribble.variable")
            .frame(width: 80, height: 80).font(.system(size: 36))
            .glassEffect()
        Image(systemName: "eraser.fill")
            .frame(width: 80, height: 80).font(.system(size: 36))
            .glassEffect()
            .offset(x: -40.0, y: 0.0)   // demo: al acercarse, las formas se funden
    }
}
```

### 4.4 `glassEffectID(_:in:)` — morphing en transiciones

```swift
nonisolated func glassEffectID(
    _ id: (some Hashable & Sendable)?,
    in namespace: Namespace.ID
) -> some View
```

- Se usa junto con `glassEffect` dentro de un `GlassEffectContainer`; el ID permite a
  SwiftUI animar las formas entre sí cuando aparecen/desaparecen vistas.
- Solo tiene efecto durante transiciones/animaciones de jerarquía.

```swift
@State private var isExpanded = false
@Namespace private var namespace

GlassEffectContainer(spacing: 40.0) {
    HStack(spacing: 40.0) {
        Image(systemName: "scribble.variable")
            .frame(width: 80, height: 80).font(.system(size: 36))
            .glassEffect()
            .glassEffectID("pencil", in: namespace)
        if isExpanded {
            Image(systemName: "eraser.fill")
                .frame(width: 80, height: 80).font(.system(size: 36))
                .glassEffect()
                .glassEffectID("eraser", in: namespace)   // morfea desde/hacia "pencil"
        }
    }
}
Button("Toggle") { withAnimation { isExpanded.toggle() } }
    .buttonStyle(.glass)
```

### 4.5 `glassEffectUnion(id:namespace:)` — unir varias vistas en una sola forma

```swift
@MainActor @preconcurrency
func glassEffectUnion(
    id: (some Hashable & Sendable)?,
    namespace: Namespace.ID
) -> some View
```

- Une los efectos glass de varias vistas (misma forma + misma variante + mismo id) en **una
  sola forma** con el material aplicado, incluso en reposo. Útil para vistas generadas
  dinámicamente o fuera de un layout container.

```swift
ForEach(symbolSet.indices, id: \.self) { item in
    Image(systemName: symbolSet[item])
        .frame(width: 80, height: 80).font(.system(size: 36))
        .glassEffect()
        .glassEffectUnion(id: item < 2 ? "1" : "2", namespace: namespace)
}
```

### 4.6 `GlassEffectTransition`

```swift
struct GlassEffectTransition
```

| Valor | Descripción |
|---|---|
| `.matchedGeometry` | Default para efectos dentro del spacing del container; morphing geométrico |
| `.materialize` | Fade del contenido + materialización del glass sin matching geométrico; usar para efectos más separados que el spacing del container |
| `.identity` | Sin cambios |

- Se aplica con el modifier `glassEffectTransition(_:)` (**UNVERIFIED la firma exacta del
  modifier; el nombre está confirmado en el artículo "Applying Liquid Glass to custom
  views"**). Combinar con `withAnimation(_:_:)`.

---

## 5. Botones glass (no reinventar)

Preferir SIEMPRE estos estilos antes que `glassEffect` manual sobre un botón.
Disponibilidad: iOS 26.0+ (todas las plataformas 26).

```swift
// Estilo glass estándar
Button("Guardar") { ... }
    .buttonStyle(.glass)          // static var glass: GlassButtonStyle

// Prominente (equivale semánticamente a .borderedProminent)
Button("Enviar") { ... }
    .buttonStyle(.glassProminent) // static var glassProminent: GlassProminentButtonStyle

// Configurable con una instancia de Glass
Button("Button") {}
    .buttonStyle(.glass(.clear))  // nonisolated static func glass(_ glass: Glass) -> Self
Button("CTA") {}
    .buttonStyle(.glass(.regular.tint(.blue)))
```

- `.glass(_:)` acepta tinte y variante (`.clear`, `.regular.tint(...)`).
- Se pueden aplicar a un contenedor para que apliquen a todos los botones dentro
  (`buttonStyle(_:)` se propaga por environment).
- Nota tvOS (irrelevante para Ristak, informativa): aplican glass sin depender del focus.

---

## 6. Scroll edge effects (legibilidad bajo controles)

### 6.1 `scrollEdgeEffectStyle(_:for:)`

```swift
nonisolated func scrollEdgeEffectStyle(
    _ style: ScrollEdgeEffectStyle?,
    for edges: Edge.Set
) -> some View
```

```swift
struct ScrollEdgeEffectStyle   // iOS 26+
// static var automatic: ScrollEdgeEffectStyle  – lo decide el sistema por plataforma/contexto
// static var hard: ScrollEdgeEffectStyle       – frontera lineal casi opaca
// static var soft: ScrollEdgeEffectStyle       – transición sutil difuminada
```

- Todo `ScrollView` renderiza un edge effect automático por defecto; las barras del sistema
  (toolbars, tab bar) ya lo activan solas. Este modifier es para cambiar el estilo:

```swift
ScrollView {
    LazyVStack { ForEach(data) { RowView($0) } }
}
.scrollEdgeEffectStyle(.hard, for: .all)
```

- `hard` conviene cuando hay controles/texto denso fijado al borde (p. ej. cabecera de
  conversación con acciones); `soft` para transiciones sutiles.

### 6.2 `scrollEdgeEffectHidden(_:for:)`

```swift
nonisolated func scrollEdgeEffectHidden(
    _ hidden: Bool = true,
    for edges: Edge.Set = .all
) -> some View
```

- Oculta el efecto por borde. Usar con cuidado: quita la protección de legibilidad.

### 6.3 `safeAreaBar(edge:alignment:spacing:content:)` — barras custom con edge effect

```swift
// Variante de borde horizontal (verificada). iOS 26+.
nonisolated func safeAreaBar(
    edge: HorizontalEdge,
    alignment: VerticalAlignment = .center,
    spacing: CGFloat? = nil,
    @ContentBuilder content: () -> some View
) -> some View
```

- Igual que `safeAreaInset(...)` pero además **extiende el scroll edge effect** de los
  scroll views afectados al área de la barra custom. Es LA API para registrar una barra
  propia (p. ej. composer de chat flotante) de modo que el contenido que scrollea debajo
  quede legible.
- **UNVERIFIED**: existe con casi total seguridad la sobrecarga `safeAreaBar(edge: VerticalEdge, ...)`
  (para barras top/bottom, el caso típico del composer); la página verificada documenta la
  variante `HorizontalEdge`. Confirmar en autocomplete de Xcode. (La página de adopción la
  enlaza genéricamente como "safeAreaBar(edge:alignment:spacing:content:)".)

---

## 7. `backgroundExtensionEffect()` — contenido edge-to-edge bajo sidebar/inspector

```swift
@MainActor @preconcurrency
func backgroundExtensionEffect() -> some View   // iOS 26+, visionOS 26+
```

- Duplica la vista en copias espejadas alrededor de cualquier borde con safe area
  disponible y les aplica blur: da la impresión de que el fondo se extiende bajo el
  sidebar/inspector **sin** mover el contenido real.
- Caso principal: imagen/hero en la columna detail de un `NavigationSplitView`.
- Aplicar **una sola instancia** por pantalla (consideración de claridad visual y
  rendimiento). El modifier recorta la vista para que las copias no se solapen.
- Overlays (títulos, botones) se añaden DESPUÉS del modifier para que no se dupliquen.

```swift
NavigationSplitView {
    // sidebar
} detail: {
    ZStack {
        BannerView()
            .backgroundExtensionEffect()
    }
}
.inspector(isPresented: $showInspector) {
    // inspector
}
```

---

## 8. TabView moderna (iPhone) y su adaptación

### 8.1 Estructura con `Tab` (iOS 18+; sintaxis actual)

```swift
// Sin selección
TabView {
    Tab("Recibidos", systemImage: "tray.and.arrow.down.fill") { ReceivedView() }
        .badge(2)
    Tab("Cuenta", systemImage: "person.crop.circle.fill") { AccountView() }
        .badge("!")
}

// Con selección programática — cada Tab lleva `value`, todos del mismo tipo Hashable
TabView(selection: $selection) {
    Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: AppTab.chats) { ChatsView() }
    Tab("Pagos", systemImage: "creditcard.fill", value: AppTab.payments) { PaymentsView() }
}
```

Inicializadores relevantes de `Tab` (struct `Tab<Value, Content, Label>`, iOS 18+):

- `init(_:systemImage:content:)` / `init(_:systemImage:value:content:)`
- `init(_:systemImage:role:content:)` / `init(_:systemImage:value:role:content:)`
- `init(_:image:...)` (asset propio), `init(content:label:)` (label custom),
  `init(role:content:)`, `init(value:role:content:)` (label inferido del role).
- Modifiers de `TabContent`: `.badge(_:)`, `.hidden(_:)`, `.customizationID(_:)`.

### 8.2 `tabViewStyle(.sidebarAdaptable)` + `TabSection` (iOS 18+)

```swift
TabView { ... }.tabViewStyle(.sidebarAdaptable)
```

- iPadOS: **top tab bar que puede adaptarse a sidebar** (el usuario alterna).
- iOS (iPhone): bottom tab bar normal.
- macOS/tvOS: siempre sidebar.
- `TabSection("Título") { Tab(...) ... }` crea jerarquía secundaria: en iPadOS aparece en
  sidebar y tab bar; en iPhone (compact) las tabs de secciones se aplanan en el tab bar sin
  header — limitar el número de tabs para que quepan.
- Personalización por el usuario (drag al tab bar, ocultar, reordenar):
  `.tabViewCustomization($customization)` con `@AppStorage var customization: TabViewCustomization`
  y `.customizationID("com.ristak.chats")` en cada Tab/TabSection.
  `customizationBehavior(_:for:)` con `.disabled` bloquea la personalización de una tab.

### 8.3 Tab de búsqueda semántica

```swift
Tab(role: .search) {
    SearchView()
}
```

- `static var search: TabRole { get }` (iOS 18+). El sistema separa esa tab del resto y la
  coloca **al trailing** con el icono estándar de lupa, consistente con el resto del OS
  (iOS 26 refuerza esta separación visual).
- Si el TabView es `searchable` y ninguna tab tiene role `.search`, la búsqueda aplica a
  todas las tabs y se resetea al cambiar de tab.
- Existe `struct TabSearchActivation` ("Configures the activation behavior of search in the
  search tab") — **UNVERIFIED los detalles**; consultar en Xcode si se necesita.

### 8.4 `tabBarMinimizeBehavior(_:)` (iOS 26+)

```swift
nonisolated func tabBarMinimizeBehavior(_ behavior: TabBarMinimizeBehavior) -> some View

struct TabBarMinimizeBehavior
// static let automatic: TabBarMinimizeBehavior  – según contexto
// static let never: TabBarMinimizeBehavior      – nunca minimiza
// static let onScrollDown: TabBarMinimizeBehavior – minimiza al empezar a scrollear hacia abajo
// static let onScrollUp: TabBarMinimizeBehavior   – minimiza al scrollear hacia arriba
```

```swift
TabView { ... }
    .tabBarMinimizeBehavior(.onScrollDown)
```

- La minimización **solo existe en iPhone**. El tab bar se re-expande al scrollear en
  dirección contraria.

### 8.5 `tabViewBottomAccessory(content:)` (iOS 26+, iPadOS 26+, Catalyst 26+)

```swift
nonisolated func tabViewBottomAccessory<Content: View>(
    @ContentBuilder content: () -> Content
) -> some View
```

- Coloca una vista persistente asociada al tab bar (patrón "mini player" de Música).
- En iPhone: con tab bar a tamaño normal el accesorio aparece **encima** del tab bar; con
  tab bar minimizado (§8.4) el accesorio se muestra **inline** junto a él.
- Adaptar el contenido leyendo el environment:

```swift
@Environment(\.tabViewBottomAccessoryPlacement) var placement
// var tabViewBottomAccessoryPlacement: TabViewBottomAccessoryPlacement? { get } — nil = indefinido

enum TabViewBottomAccessoryPlacement {
    case inline    // en línea con el tab bar minimizado
    case expanded  // barra expandida encima del tab bar (o al fondo del contenido si no hay tab bar)
}
```

---

## 9. Navegación: `NavigationStack`, `NavigationSplitView`, `inspector`

### 9.1 `NavigationStack` (iOS 16+)

```swift
nonisolated struct NavigationStack<Data, Root> where Root : View
init(root: () -> Root)
init(path: Binding<...>, root: () -> Root)   // path: [T] homogéneo o NavigationPath
```

Patrón valor-destino (el correcto para esta app; NO usar `NavigationLink(destination:)` legacy):

```swift
@State private var path: [Conversation] = []   // deep links / restauración / navegación programática

NavigationStack(path: $path) {
    List(conversations) { convo in
        NavigationLink(convo.title, value: convo)
    }
    .navigationDestination(for: Conversation.self) { convo in
        ConversationView(conversation: convo)
    }
}
```

- Varios `navigationDestination(for:)` para varios tipos; con tipos mixtos usar `NavigationPath`.
- Mutar el array = navegar (push/pop programático). Back del sistema hace `removeLast`.

### 9.2 `NavigationSplitView` (iOS 16+) — el shell de iPad

```swift
nonisolated struct NavigationSplitView<Sidebar, Content, Detail>

// 2 columnas
init(sidebar: () -> Sidebar, detail: () -> Detail)
// 3 columnas
init(sidebar: () -> Sidebar, content: () -> Content, detail: () -> Detail)
// + control de visibilidad de columnas
init(columnVisibility: Binding<NavigationSplitViewVisibility>, sidebar:..., detail:...)
init(columnVisibility: Binding<NavigationSplitViewVisibility>, sidebar:..., content:..., detail:...)
// + columna preferida al colapsar (iPhone / iPad compacto)
init(preferredCompactColumn: Binding<NavigationSplitViewColumn>, sidebar:..., detail:...)
init(preferredCompactColumn: Binding<NavigationSplitViewColumn>, sidebar:..., content:..., detail:...)
// + ambos
init(columnVisibility:..., preferredCompactColumn:..., sidebar:..., [content:...,] detail:...)
```

Comportamiento clave (verificado):

- La selección de un `List(selection:)` en la columna anterior controla la siguiente.
- **En tamaños estrechos (iPhone, iPad Slide Over) el split view colapsa a un stack** y
  muestra la última columna con información útil; las filas con `NavigationLink` dibujan
  chevrons en estado colapsado. Con `preferredCompactColumn` se controla qué columna queda
  arriba al colapsar (`NavigationSplitViewColumn` — valores `.sidebar` / `.detail`
  verificados en ejemplo; `.content` **UNVERIFIED** pero implícito para 3 columnas).
- `NavigationSplitViewVisibility.detailOnly` verificado en ejemplo; valores estándar
  adicionales `.automatic`, `.all`, `.doubleColumn` (**estándar iOS 16, no re-verificados aquí**).
- La visibilidad se ignora cuando el split colapsa a stack.
- Ancho de columnas: `navigationSplitViewColumnWidth(_:)` y
  `navigationSplitViewColumnWidth(min:ideal:max:)` (por columna).
- Estilo: `navigationSplitViewStyle(_:)` — enfatizar detail o columnas con igual prominencia
  (valores estándar `.balanced` / `.prominentDetail` / `.automatic` — **estándar, no re-verificados**).
- El sistema añade el toolbar item `sidebarToggle`; se quita con `.toolbar(removing: .sidebarToggle)`.
- Se puede anidar un `NavigationStack` dentro de una columna (típico: stack en detail).
- iPadOS 26: ventanas con **resize continuo** — los split views refluyen automáticamente;
  soportar tamaños arbitrarios y usar safe areas/layout guides.

### 9.3 `inspector(isPresented:content:)` (iOS 17+)

```swift
nonisolated func inspector<V: View>(
    isPresented: Binding<Bool>,
    @ContentBuilder content: () -> V
) -> some View
```

- Columna trailing en horizontal regular (iPad); **se adapta a sheet en compact** (iPhone).
- El estado de presentación de inspectores en columna lo restaura el framework.
- Patrón Ristak: panel de info del contacto en la conversación (iPad = inspector,
  iPhone = sheet automática con la misma llamada).
- Auditar safe areas del contenido junto a sidebar/inspector para que el contenido se asome
  correctamente (y §7 para extender fondos).

### 9.4 Título y subtítulo de navegación

```swift
.navigationTitle("Chats")                    // estándar
.navigationSubtitle("23 sin leer")           // iOS 26.0+ / iPadOS 26.0+ (macOS 13+)
// @export(implementation) nonisolated func navigationSubtitle(_ subtitleKey: LocalizedStringResource) -> some View
```

- En iOS/iPadOS 26 el subtítulo se muestra junto al título en la navigation bar.
- Placements de toolbar asociados (iOS 26, ver §11.1): `.title`, `.subtitle`, `.largeTitle`,
  `.largeSubtitle` para poner vistas en el área del título.

---

## 10. Búsqueda

### 10.1 `searchable` (firmas verificadas)

```swift
// iOS 15+
nonisolated func searchable<S: StringProtocol>(
    text: Binding<String>,
    placement: SearchFieldPlacement = .automatic,
    prompt: S
) -> some View

// iOS 17+ — presentación programática del campo
@export(implementation) nonisolated func searchable(
    text: Binding<String>,
    isPresented: Binding<Bool>,
    placement: SearchFieldPlacement = .automatic,
    prompt: LocalizedStringResource
) -> some View
```

(Existen las sobrecargas estándar sin `prompt` / con `LocalizedStringKey` / con `tokens` —
familia estándar de iOS 15–17, no re-verificadas aquí.)

### 10.2 `SearchFieldPlacement` (verificado)

| Valor | Descripción |
|---|---|
| `.automatic` | El sistema decide (default) |
| `.navigationBarDrawer` | En un drawer bajo la navigation bar |
| `.navigationBarDrawer(displayMode:)` | Con `NavigationBarDrawerDisplayMode` (`.automatic`/`.always` — **estándar, no re-verificado**) |
| `.sidebar` | En el sidebar de un navigation view (iPad) |
| `.toolbar` | En el toolbar (en iPhone iOS 26 ⇒ campo en el bottom toolbar) |
| `.toolbarPrincipal` | Sección principal (centro) del toolbar |

### 10.3 `searchToolbarBehavior(_:)` (iOS 26+)

```swift
nonisolated func searchToolbarBehavior(_ behavior: SearchToolbarBehavior) -> some View

struct SearchToolbarBehavior
// static var automatic: SearchToolbarBehavior
// static var minimize: SearchToolbarBehavior  – el campo se renderiza como control tipo botón (lupa) hasta que se toca
```

```swift
NavigationStack {
    RecipeList()
        .searchable(text: $searchText, prompt: "Buscar")
        .searchToolbarBehavior(.minimize)
}
```

- Colocarlo DESPUÉS del `searchable` que renderiza en el toolbar.
- En iPhone convierte el campo del bottom toolbar en un botón de lupa compacto (patrón iOS 26).
- ⚠️ La página del modifier muestra `.minimized` en su snippet, pero la propiedad declarada
  del tipo es **`minimize`** (`/documentation/swiftui/searchtoolbarbehavior/minimize`).
  Es una errata de la doc de Apple; usar `.minimize` y confiar en el compilador.

### 10.4 Convenciones iOS 26 de búsqueda (Adopting Liquid Glass)

- iPhone: al enfocar, el campo se desliza hacia arriba con el teclado (verificar que en
  pantallas custom se mueva igual que en el resto del sistema).
- iPad: campo por defecto en la esquina del toolbar / sidebar según layout.
- Con tab bar: usar `Tab(role: .search)` (§8.3) — el sistema la separa al trailing.

---

## 11. Toolbars

### 11.1 `ToolbarItem` / `ToolbarItemGroup` / placements

```swift
nonisolated struct ToolbarItemGroup<Content> where Content : View  // iOS 14+
init(placement: ToolbarItemPlacement, content: () -> Content)
init<C, L>(placement: ToolbarItemPlacement, content: () -> C, label: () -> L)
```

`ToolbarItemPlacement` (verificado; iOS 14+ salvo nota):

| Placement | Tipo | Nota |
|---|---|---|
| `.automatic` | semántico | default |
| `.principal` | semántico | sección principal |
| `.status` | semántico | cambios de estado |
| `.primaryAction` / `.secondaryAction` | acción | |
| `.confirmationAction` / `.cancellationAction` / `.destructiveAction` | modal | sheets de edición |
| `.navigation` | acción | back/forward-like |
| `.topBarLeading` / `.topBarTrailing` | posicional | (los `navigationBarLeading/Trailing` están deprecados) |
| `.topBarPinnedTrailing` | posicional | **(beta)** fija el item al trailing |
| `.bottomBar` | posicional | bottom toolbar |
| `.keyboard` | posicional | fila sobre el teclado |
| `.title` / `.subtitle` / `.largeTitle` / `.largeSubtitle` | posicional | áreas de título de la nav bar (nuevos; sin anotación de versión en la página — **asumir iOS 26, UNVERIFIED exacto**) |
| `.accessoryBar(id:)` | posicional | barras accesorias (macOS principalmente) |

- Si no caben todos los items, el sistema crea un menú de overflow automáticamente.
- Ocultar un item: esconder el **ToolbarItem entero** con `hidden(_:)` de `ToolbarContent`
  (no la vista interior, o queda un hueco glass vacío).

### 11.2 `ToolbarSpacer` (iOS 26+, iPadOS 26+, Catalyst 26+, macOS 26+)

```swift
nonisolated struct ToolbarSpacer
init(_ sizing: SpacerSizing, placement: ToolbarItemPlacement)
// SpacerSizing: .fixed (separa grupos con hueco fijo) | .flexible (empuja items) — defaults de los parámetros UNVERIFIED
```

```swift
ContentView()
    .toolbar(id: "main-toolbar") {
        ToolbarItem(id: "tag") { TagButton() }
        ToolbarItem(id: "share") { ShareButton() }
        ToolbarSpacer(.fixed)          // rompe el fondo glass compartido → dos grupos
        ToolbarItem(id: "more") { MoreButton() }
    }
```

- En iOS 26 los items contiguos comparten **un fondo glass**; `ToolbarSpacer(.fixed)` crea
  la separación visual entre grupos. Agrupar acciones relacionadas (mismo grupo) y separar
  las que afectan a partes distintas de la UI.
- Iconos > texto para acciones comunes; **no mezclar texto e iconos** dentro de items que
  comparten fondo; SIEMPRE `accessibilityLabel` en items de solo icono.

---

## 12. Sheets, popovers y modales

### 12.1 Sheets con detents (iOS 16+)

```swift
nonisolated func presentationDetents(_ detents: Set<PresentationDetent>) -> some View

struct PresentationDetent
// static let large: PresentationDetent      – altura completa (default de toda sheet)
// static let medium: PresentationDetent     – ~mitad de pantalla; INACTIVO en compact height (iPhone landscape)
// static func fraction(CGFloat) -> PresentationDetent
// static func height(CGFloat) -> PresentationDetent
// static func custom<D: CustomPresentationDetent>(D.Type) -> PresentationDetent
```

```swift
.sheet(isPresented: $showSettings) {
    SettingsView()
        .presentationDetents([.medium, .large])
}
```

- iOS 26 automático: half-sheets inseteadas del borde (contenido se asoma por debajo),
  corner radius mayor, transición a más opaco al expandir a full height. Revisar contenido
  cerca de las esquinas (más redondas).
- `presentationDragIndicator(_:)` — estándar iOS 16 (**no re-verificado**).

### 12.2 `presentationBackground(_:)` (iOS 16.4+)

```swift
nonisolated func presentationBackground<S: ShapeStyle>(_ style: S) -> some View
```

- Rellena toda la presentación y permite ver a través con estilos translúcidos (a diferencia
  de `background(_:)`).
- **Regla iOS 26: NO poner fondos custom a sheets/popovers** — el sistema ya provee el
  material correcto ("Audit the backgrounds of sheets and popovers... remove those custom
  background views"). Usar solo si hay una razón fuerte (p. ej. `.clear` para experiencias media).

### 12.3 Popovers y su adaptación iPhone/iPad

```swift
@export(implementation) nonisolated func popover<Content: View>(
    isPresented: Binding<Bool>,
    attachmentAnchor: PopoverAttachmentAnchor = .rect(.bounds),
    arrowEdge: Edge? = nil,
    @ContentBuilder content: @escaping () -> Content
) -> some View   // iOS 13+; también popover(item:...)
```

- **iPad**: popover real anclado (glass automático en iOS 26).
- **iPhone**: se adapta a **sheet** automáticamente; en vertical compacto (landscape iPhone)
  a full-screen cover.
- Overridear la adaptación:

```swift
nonisolated func presentationCompactAdaptation(_ adaptation: PresentationAdaptation) -> some View
// PresentationAdaptation: .automatic / .none / .popover / .sheet / .fullScreenCover
//   (.none verificado; el resto estándar iOS 16.4 — no re-verificados)
.popover(isPresented: $show) {
    FilterView()
        .presentationCompactAdaptation(.popover)   // fuerza popover también en iPhone
}
```

### 12.4 Action sheets (`confirmationDialog`) y formas concéntricas

- iOS 26: `confirmationDialog(_:isPresented:titleVisibility:presenting:actions:)` se origina
  **desde el elemento que la dispara** (anclaje inline), no desde el borde inferior; el
  resto de la UI sigue interactivo. Colocar el modifier en el control origen para el anclaje.
- Esquinas concéntricas para vistas custom cercanas a bordes redondeados:

```swift
struct ConcentricRectangle   // iOS 26+
ConcentricRectangle()                                  // 4 esquinas concéntricas al container
ConcentricRectangle(corners: .concentric(minimum: 12), isUniform: true)
// estilos de esquina (Edge.Corner.Style): .concentric, .concentric(minimum:), .fixed(CGFloat)
// atajo Shape: .rect(corners: .concentric, isUniform: false)
// inits por esquina/uniformes: (topLeadingCorner:topTrailingCorner:bottomLeadingCorner:bottomTrailingCorner:),
//   (uniformTopCorners:uniformBottomCorners:), (uniformLeadingCorners:uniformTrailingCorners:), etc.
```

- El cálculo de radio usa el **container shape** (`containerShape(_:)` con un
  `RoundedRectangularShape` como `RoundedRectangle`, `Capsule`...); los componentes del
  sistema ya definen container shapes.

---

## 13. Estado moderno: `@Observable` y property wrappers

```swift
@Observable            // macro, iOS 17+ (framework Observation)
class ChatsModel {
    var conversations: [Conversation] = []
    var isLoading = false
}
```

- `@Observable` (macro `Observable()`) conforma la clase a `Observable` y genera el
  tracking; las vistas que leen propiedades se invalidan solo por las propiedades leídas
  (mejor rendimiento que `ObservableObject`).
- Patrón recomendado para esta app (SwiftUI moderno):
  - `@State` — estado local de la vista, incl. **instancias de modelos `@Observable`**
    creadas por la vista (`@State private var model = ChatsModel()`).
  - `@Binding` — referencia mutable a estado de otra vista.
  - `@Bindable` — para obtener bindings de propiedades de un objeto `@Observable`
    (`@Bindable var model: ChatsModel` → `$model.searchText`).
  - `@Environment(ChatsModel.self)` — inyección de objetos `@Observable` por environment
    (`.environment(model)`); `@Environment(\.horizontalSizeClass)` etc. para valores.
  - `@StateObject` / `@ObservedObject` solo para tipos legacy `ObservableObject` — **evitar
    en código nuevo**.
- Entry point: `@main struct RistakApp: App { var body: some Scene { WindowGroup { ContentView() } } }`.

---

## 14. Layout adaptativo iPhone ↔ iPad

### 14.1 Size classes

```swift
@Environment(\.horizontalSizeClass) private var horizontalSizeClass  // UserInterfaceSizeClass?
@Environment(\.verticalSizeClass) private var verticalSizeClass

enum UserInterfaceSizeClass { case compact, regular }
```

- Factores: tipo de dispositivo, orientación, Slide Over/Split View en iPad. **Puede cambiar
  en runtime** — no cachear decisiones de layout.
- iPhone: horizontal compact (salvo Plus/Max landscape = regular). iPad fullscreen: regular;
  iPad en Slide Over/split estrecho: compact (la app DEBE seguir siendo usable en compact
  también en iPad).

### 14.2 Decisión de shell para una app CRM universal

Dos patrones válidos según Apple; elegir uno y ser consistente:

1. **`TabView` + `.sidebarAdaptable`** (§8.2): mismas tabs en iPhone (bottom bar) y iPad
   (top tab bar ↔ sidebar). Simple, con búsqueda como `Tab(role: .search)`.
2. **`NavigationSplitView` como raíz** (patrón Landmarks): sidebar propio en iPad con
   `List(selection:)`, colapso automático a stack en iPhone. Más control (columna
   lista + detalle simultáneos en iPad, inspector para el panel de contacto), recomendado
   por Apple para "sidebar layouts with an inspector panel".
   - Para Ristak (lista de conversaciones + hilo + info de contacto) el patrón
     **NavigationSplitView (2 columnas) + inspector** encaja de forma natural en iPad;
     en iPhone colapsa a stack estándar. Si el producto exige tabs de primer nivel
     (Chats/Calendarios/Pagos/Analíticas/Ajustes), combinar: `TabView` raíz y dentro de la
     tab de Chats un `NavigationSplitView` — ambos composables. (Recomendación, no regla de Apple.)
3. En cualquier caso: iPadOS 26 = ventanas redimensionables continuamente → **no** asumir
   tamaños fijos; probar todos los anchos; dejar que split views refluyan.

### 14.3 Presentaciones por dispositivo

| Necesidad | iPhone | iPad | API |
|---|---|---|---|
| Detalle/acción contextual ligera | sheet (adaptación automática) | popover anclado | `.popover(...)` (se auto-adapta) |
| Panel lateral de propiedades | sheet | columna inspector | `.inspector(isPresented:)` |
| Flujo modal | sheet con detents | sheet centrada | `.sheet` + `presentationDetents` |
| Confirmación destructiva | action sheet anclada | popover anclado | `confirmationDialog` (+ anclaje al control) |

---

## 15. Accesibilidad y ajustes de usuario

### 15.1 Environment values (verificados, iOS 13+)

```swift
@Environment(\.accessibilityReduceTransparency) var reduceTransparency: Bool
// true ⇒ los fondos NO deben ser semitransparentes; usar fondos opacos

@Environment(\.accessibilityReduceMotion) var reduceMotion: Bool
// true ⇒ evitar animaciones grandes, sobre todo las que simulan 3D

@Environment(\.dynamicTypeSize) var dynamicTypeSize: DynamicTypeSize
// cambia con el ajuste del usuario; si se limita, considerar accessibilityShowsLargeContentViewer()
```

### 15.2 Reglas iOS 26

- **Componentes del sistema**: se adaptan solos a Reducir transparencia / Reducir
  movimiento / contraste aumentado / "apariencia preferida de Liquid Glass" (ajuste de
  usuario del dispositivo). No hay que hacer nada.
- **Vistas custom con `glassEffect`**: Apple exige "test your app's custom elements,
  colors, and animations with different configurations of these settings". Patrón de fallback:

```swift
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

var body: some View {
    content
        .glassEffect(reduceTransparency ? .identity : .regular)
        .background(reduceTransparency ? AnyShapeStyle(.background) : AnyShapeStyle(.clear))
}
```

  (El uso de `.identity` como fallback es composición nuestra sobre APIs verificadas;
  el mecanismo exacto con el que el sistema degrada `glassEffect` custom bajo Reduce
  Transparency no está documentado — **OPEN QUESTION**, probar en device.)
- **Morphing con `glassEffectID`**: condicionar `withAnimation` a `!reduceMotion` o usar
  `GlassEffectTransition.materialize` (transición más simple).
- **Dynamic Type**: usar text styles (`.font(.body)` etc.), nunca tamaños fijos; probar
  hasta tamaños XXL y AX; los controles iOS 26 traen tamaño "extra-large" opcional para labels.
- **Toolbar icons**: `accessibilityLabel` obligatorio en todo item de solo icono (VoiceOver/Voice Control).
- **Color**: variantes light/dark + contraste aumentado para todo color custom en
  controles/navegación (HIG).

---

## 16. Checklist de implementación para Ristak iOS

1. Compilar con Xcode 26 / SDK iOS 26; **sin** `UIDesignRequiresCompatibility`.
2. Cero fondos custom en nav bars/tab bars/toolbars/sheets; dejar el glass del sistema.
3. Shell: `TabView` con `Tab`s tipadas (+ `Tab(role: .search)` si hay búsqueda global) y
   `.tabViewStyle(.sidebarAdaptable)` **o** `NavigationSplitView` raíz (§14.2);
   `tabBarMinimizeBehavior(.onScrollDown)` en iPhone si la lista de chats es larga.
4. Navegación por valores: `NavigationStack(path:)` + `navigationDestination(for:)`.
5. Panel contacto/CRM en conversación: `.inspector` (iPad columna / iPhone sheet).
6. Sheets de acciones con `presentationDetents([.medium, .large])`; popovers para iPad con
   `presentationCompactAdaptation` según el caso.
7. Composer del chat: preferir toolbar del sistema (`.bottomBar`) o `safeAreaBar` para
   heredar scroll edge effect; NO una barra flotante con fondo manual.
8. Glass custom solo para elementos flotantes propios (p. ej. FAB de "nuevo chat",
   chips de filtros flotantes): `GlassEffectContainer` + `glassEffect` + `.interactive()`,
   botones con `.buttonStyle(.glass)` / `.glassProminent` para el CTA principal.
9. Toolbars: iconos SF Symbols + `ToolbarSpacer(.fixed)` entre grupos + `accessibilityLabel`.
10. Probar: 4 configuraciones (iPhone compact, iPhone landscape, iPad regular, iPad
    Slide Over/compact) × light/dark × Reduce Transparency/Motion × Dynamic Type grande.

---

## 17. Gaps / riesgos para iOS nativo

1. **Firma de `glassEffectTransition(_:)`** no verificada (el tipo `GlassEffectTransition` y
   sus tres valores sí). Verificar en autocomplete antes de usar.
2. **`safeAreaBar` con `VerticalEdge`** (barra bottom/top, el caso del composer): solo se
   verificó la sobrecarga `HorizontalEdge`. Confirmar la variante vertical en Xcode.
3. **Errata en docs de Apple**: `searchToolbarBehavior` — la propiedad real es `.minimize`,
   el ejemplo de Apple dice `.minimized`. Usar `.minimize`.
4. **Degradación de `glassEffect` custom bajo Reduce Transparency**: comportamiento del
   sistema no documentado para efectos custom (los componentes estándar sí se adaptan).
   OPEN QUESTION — validar en device con el ajuste activado y decidir si hace falta el
   fallback manual de §15.2.
5. **`.topBarPinnedTrailing` está en beta** en la doc; puede cambiar. No depender de él.
6. **Placements `.title/.subtitle/.largeTitle/.largeSubtitle`**: la página de
   `ToolbarItemPlacement` no anota versión mínima por símbolo en el JSON extraído; asumir
   iOS 26 y verificar disponibilidad real al compilar (UNVERIFIED exacto).
7. **`TabSearchActivation`**: existe pero sin detalles verificados; solo relevante si se
   quiere personalizar cómo se activa la búsqueda al tocar la tab search.
8. **Simulador vs device**: los efectos de refracción/specular de Liquid Glass y su costo
   de GPU deben validarse en hardware real; Apple recomienda perfilar
   ("Optimize SwiftUI performance with Instruments", wwdc2025/306). Regla: pocos
   `GlassEffectContainer`, pocos efectos simultáneos en pantalla.
9. **Dependencia de diseño propio (tokens Ristak)**: el design system web de Ristak
   (familias Aurora/Onyx/Brut/Nimbus, tokens CSS) NO aplica 1:1 a iOS 26: en nativo mandan
   los componentes del sistema + Liquid Glass, y el color se usa con moderación en la capa
   de navegación. OPEN QUESTION de producto: cuánto branding (acento, tinte de
   `.glassProminent`) se traslada a la app nativa — decidir con el usuario; técnicamente el
   punto de inyección son `Color` assets con variantes light/dark/high-contrast y `tint`.
10. **Mínimo de despliegue**: todo el bloque glass exige iOS 26; `Tab`/`TabSection`/
    `sidebarAdaptable` exigen iOS 18; `@Observable` iOS 17; `inspector` iOS 17. Como la app
    se define iOS 26-only, no hay ramas de compatibilidad — pero cualquier decisión futura
    de bajar el target rompe §4–§8 y §10.3.
