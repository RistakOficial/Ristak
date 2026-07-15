# 🛑 SISTEMA DE DISEÑO DE RISTAK — REGLAS OBLIGATORIAS (escritorio)

> ## ALTO. LÉEME ANTES DE TOCAR UI.
>
> Si vas a crear o modificar **cualquier** pantalla, componente, estilo o
> función que tenga interfaz, **es OBLIGATORIO** que:
>
> 1. **Abras `docs/design-reference/design-system.html`** en el navegador
>    interno/aislado del agente y veas cómo se ve el componente/pantalla que vas a
>    tocar (ahí está TODO: los 4 temas, todos los componentes y todas las pantallas
>    en claro y oscuro). **No uses Google Chrome ni el navegador personal del
>    usuario** salvo que el usuario lo pida explícitamente. Si `file://` queda
>    bloqueado, sirve `docs/design-reference/` por `127.0.0.1` desde el worktree y
>    abre esa URL en el navegador interno.
> 2. **Reutilices** los componentes de `frontend/src/components/common/` y los
>    **tokens** de `frontend/src/styles/index.css`. No inventes nada.
> 3. **Pruebes tu cambio en las 4 familias × claro/oscuro** antes de darlo por
>    hecho (sobre todo **Onyx**, que destapa bugs de contraste).
> 4. **Corras `cd frontend && npm run design:audit`** antes de cerrar. Si falla,
>    no lo tapes: usa el componente global correcto o convierte el patrón en una
>    extensión documentada del sistema.
>
> La congruencia de marca **no es negociable**, aunque la función sea nueva.
> Una pantalla que "parece de otra app" se **rechaza en review**. No hay excusa
> de "es una función nueva": las funciones nuevas también usan el diseño global.

La referencia visual vive en **[`docs/design-reference/`](design-reference/)**
(ábrela en el navegador interno/aislado del agente). El código que la implementa
vive en `frontend/src/styles/index.css`
(tokens) y `frontend/src/components/common/` (componentes). **Referencia = el
"qué/por qué"; código = el "cómo". Si tu pantalla no se parece a la referencia,
está mal.**

---

## 1. La estética: un solo producto, 4 familias de tema

Ristak de escritorio es **un solo producto coherente**, no pantallas sueltas.
El sistema soporta **4 familias visuales** seleccionables por el usuario, cada una
con variantes de color y modo claro/oscuro. El **default es Aurora · Neutral**.

| Familia | `data-dir` | Carácter |
| --- | --- | --- |
| **Aurora** (default) | `en` Neutral, `e` Violeta, `eb` Azul, `em` Sobria | Glass, profundidad, degradados suaves |
| **Onyx** | `c` Esmeralda, `cb` Azul, `cv` Violeta, `ca` Ámbar | Alto contraste, **panel lateral SIEMPRE oscuro** |
| **Brut** | `d` Rojo, `db` Azul, `dl` Lima, `dm` Magenta | Neobrutalismo: bordes duros, mono, sombras sólidas |
| **Nimbus** | `a` Clásico, `av` Violeta, `ab` Azul, `am` Sobria | Limpio, profesional, neutro frío |

- El usuario elige familia/variante/modo en el **menú de usuario del sidebar**;
  el motor está en `frontend/src/contexts/ThemeContext.tsx` (atributo `data-dir`
  en `<body>`, modo con clase `.light/.dark`, persistido en `theme_dir`).
- **Tu UI debe verse correcta en TODAS las familias automáticamente.** Eso solo
  pasa si usas tokens (§3). Si hardcodeas un color, se rompe en alguna familia.

---

## 2. Dónde vive el sistema

| Pieza | Archivo |
| --- | --- |
| **Referencia visual (ábrela en navegador interno)** | `docs/design-reference/design-system.html` |
| Núcleo de tokens + 4 familias + capa de compatibilidad | `frontend/src/styles/index.css` (bloque "SISTEMA DE DISEÑO GLOBAL" al final) |
| Motor de temas (familia/variante/modo) | `frontend/src/contexts/ThemeContext.tsx` |
| Componentes compartidos | `frontend/src/components/common/` |
| Vocabulario de estados (badges) | `frontend/src/utils/statusBadges.ts` + `contactStageBadge.ts` |
| Tokens TS para gráficas | `frontend/src/theme/tokens.ts` |

**Regla de oro:** si un valor existe como token (`var(--…)`), **úsalo**. Nunca
hardcodees colores hex/rgba ni tamaños improvisados.

---

## 3. Tokens — el único vocabulario de color/forma permitido

Usa **siempre** estos tokens nuevos (cambian solos por familia y por modo):

```
Superficies:  --bg  --bg-soft  --surface  --surface-2  --surface-hover  --surface-solid
Texto:        --text  --text-dim  --text-mute   (on-accent: --on-accent)
Bordes:       --border  --border-strong
Acento:       --accent  --accent-2  --accent-soft   (rgb: --accent-rgb)
Semántico:    --pos --pos-soft   --neg --neg-soft   --warn --warn-soft   --info --info-soft
Marca:        --brand-ristak-blue  --brand-ristak-blue-rgb
Forma:        --radius-card  --radius-ctl  --radius-pill
Sombra:       --shadow-card  --shadow-xs  --shadow-pop
Tipografía:   --font-display  --font-body  --font-mono  --num-font  --label-font
Layout:       --sidebar  --topbar  --chart-grid
```

Los tokens viejos (`--color-text-primary`, `--color-primary`, `--design-*`,
`--radius-md`, etc.) **siguen funcionando** porque una capa de compatibilidad en
`index.css` los re-apunta a los de arriba. Pero para código **nuevo** prefiere
los nuevos. **Jamás** declares un alias nuevo en `:root` que apunte a un token
temado (se congela con el default oscuro); decláralo en `body` si hace falta.

---

## 4. Componentes que SIEMPRE se reutilizan (no reinventes)

Regla de religión del producto: si un patrón se repite en más de una pantalla,
**vive en `frontend/src/components/common/` o como recipe global documentada
aquí**. Las páginas solo acomodan el layout y pasan datos; no inventan su propio
look para buscadores, botones, inputs con iconos, tabs, cards, tablas, modales,
badges, menús o pills. Si necesitas una variación real, extiende el componente
global con props/tokens y documenta la variación en esta guía.

**Regla operativa para filtros, formularios, modales y botones:** antes de crear
un control nuevo, revisa si ya existe una primitiva global o móvil que resuelva
el patrón. Si existe, úsala y cambia únicamente los datos, textos, opciones o
condiciones de negocio que alimentan el componente. No copies el JSX/CSS de una
pantalla para hacer “otro igual”; extrae o extiende el núcleo compartido. Esto
aplica especialmente a filtros tipo chip, formularios, botones, modales, sheets,
segmentos, menús y campos con icono.

La guardia automática vive en `frontend/scripts/audit-design-system.mjs` y se
ejecuta con `npm run design:audit`. Bloquea patrones locales nuevos como
`.searchBox`, `.searchInput`, `.inputWithIcon`, `.tabs`, `.badge`, `.modal`,
`.table` y colores semánticos hardcodeados. La allowlist del script es deuda
legacy identificada; no es permiso para copiar ese estilo en pantallas nuevas.

| Necesitas… | Usa | Nunca |
| --- | --- | --- |
| Botón | `<Button variant="primary\|secondary\|ghost\|danger">` | `<button>` con estilos propios |
| Etiqueta de estado / badge | `<Badge variant=…>` (+ `utils/statusBadges`) | un `span` "pill" con colores a mano |
| Buscador | `<SearchField>`; para casos especializados `<ContactSearchInput>` / `<GlobalSearch>` | un `Search` + `<input>` + botón `X` con CSS local; un input con fondo `transparent`/`--bg`/glass (¡desaparece en Onyx!) |
| Filtros tipo chip en móvil | `<PhoneFilterChips>` desde `components/phone/ui` | repetir `.filterChips`, `.aiAgentHubFilterChip` o carriles scrollables a mano |
| Tabs segmentados (en card) | `<TabList>` | rgba hardcodeados |
| Tabs de sub-sección (underline) | `<SegmentTabs>` (recipe `[data-segdir]`) | un nav a mano |
| Switch / toggle | `<Switch>` (recipe `[data-sw]`) | un checkbox estilizado a mano |
| Select enriquecido | `<CustomSelect>` | — |
| Código telefónico internacional | `<PhoneCountryCodeSelect>`; muestra únicamente bandera + código (`🇲🇽 +52`) | un select local que agregue el nombre del país |
| Campo numérico | `<NumberInput>`; en primitivas móviles, `type="text"` + `inputMode="numeric\|decimal"` | `<input type="number">` nativo o controles con flechas subir/bajar |
| Texto largo enfocable | `<ExpandableTextareaField>`; comparte el mismo valor entre el campo y su editor `<Modal size="xl">` | duplicar estado, recortar silenciosamente o construir un overlay local |
| Ruta / slug con prefijo fijo | `<PathInput prefix="…">` | un wrapper con prefijo + `<input className={styles.input}>` que crea doble contenedor |
| Menú | `<DropdownMenu>` | — |
| Modal / overlay | `<Modal>` (recipe `[data-overlay]`/`[data-modal]`) | un `position:fixed` a mano |
| Confirmar borrar/desconectar/revocar | `showConfirm(...)` del `NotificationContext` (o `<Modal type="confirm" typeToConfirm="…">`) — ver §4.1 | `window.confirm`, un modal de confirmación a mano, copiar el JSX de otro borrado |
| Card / KPI | `<Card>` / `<KpiCard>` (llevan `data-ristak-card`) | — |
| Tabla | `<Table>` (o la receta §6) | una `<table>` desde cero |
| Header / contenedor de página | `<PageHeader>` / `<PageContainer>` | un header a mano |
| Inputs nativos | ya están skineados globalmente; un `<input>` plano hereda el sistema | re-estilizarlos |

**Separador único de página.** El encabezado es el dueño de la línea que separa
el título del contenido. La primera sección que aparece inmediatamente después
no debe volver a pintar `border-top`; las secciones posteriores sí pueden usar
una línea para separar bloques. En pantallas legacy con `.pageHeader`, resuelve
esta convivencia en el estilo compartido para que todas sus consumidoras
mantengan una sola línea, sin quitar los divisores internos legítimos.

Foco: `--ristak-focus-ring` / borde `--accent`. **Nunca** un ring de color a mano.

Responsive: sí se permite ajustar ancho, densidad y orden visual para ventanas
chicas usando `flex`, `grid`, `minmax`, `clamp`, `min-width: 0`, container/media
queries y variables del componente. Lo que no se permite es crear otro estilo
visual por página para "resolver" pantallas chicas.

**Selector de código telefónico.** En cualquier formulario que separa la región
del número, el control visible usa únicamente `bandera + código internacional`
(`🇲🇽 +52`). El trigger y sus opciones nunca agregan el nombre del país. Esta
regla no afecta selectores de país fiscal, país de la cuenta, dirección o
facturación, donde el nombre sí aporta contexto y debe conservarse.

**Menú de usuario del sidebar:** el panel de cuenta y temas se abre como popover
lateral, anclado al borde exterior derecho del sidebar y alineado con el bloque
del usuario. Nunca debe desplegarse encima de la navegación. Su ancho se limita
al espacio disponible del viewport y su contenido puede desplazarse verticalmente
cuando la ventana es chica.

### 4.1 Confirmaciones destructivas (borrar / desconectar / revocar) — el ÚNICO patrón

Toda confirmación previa a una acción **destructiva o irreversible** usa **el mismo
elemento y las mismas reglas**, sin excepción. No hay "modal de borrado propio" por
pantalla. Está prohibido `window.confirm`, prohibido portalar un overlay a mano y
prohibido copiar el JSX/CSS de otro modal de borrado.

**1 · El elemento.** Siempre el `Modal` canónico, por una de dos vías:
- **Preferida:** el helper `showConfirm(...)` del `NotificationContext`
  (`useNotification()`). Monta el `<Modal type="confirm">` global; no montas nada.
- **Inline `<Modal type="confirm" …>`** solo si necesitas `size`, `children` o un
  layout propio (p. ej. una barra de progreso durante un borrado masivo). Sigue
  siendo el mismo componente, con `typeToConfirm`/`confirmText` estándar.

**2 · La palabra a teclear (`typeToConfirm`) → MAYÚSCULAS y es el VERBO de la acción.**
La validación del Modal ignora mayúsculas y acentos, pero el **valor canónico se
escribe en mayúsculas** para que el label y el placeholder se vean iguales en toda
la app:

| Acción | `typeToConfirm` |
| --- | --- |
| Borrar / eliminar cualquier dato | `ELIMINAR` |
| Desconectar una integración | `DESCONECTAR` |
| Revocar una credencial / token | `REVOCAR` |
| Regenerar un token | `GENERAR` |
| Otro verbo de riesgo (apagar/ocultar…) | el verbo en mayúsculas (`APAGAR`, `OCULTAR`) |

**3 · Cuándo SÍ se pide teclear la palabra (por riesgo).** No todo borrado la pide;
se decide por impacto, no por capricho:
- **SÍ (obligatorio `typeToConfirm`):** borrados irreversibles de un registro/entidad
  (contacto, pago, suscripción, plan, sitio, campo, etiqueta, plantilla, enlace,
  dominio, archivo/carpeta de Media, automatización, acceso de usuario, token);
  borrados **masivos** (varios a la vez); borrados **en cascada** (borran datos
  relacionados: campo→sus valores, etiqueta→de todos los contactos, sitio→sus
  respuestas, calendario→sus citas); **desconectar integraciones** / revocar
  credenciales; acciones **financieras** irreversibles (anular, reembolsar,
  cancelar/eliminar plan); **borrado permanente**; y toggles de alto impacto
  declarados peligrosos (apagar anti-bloqueos, etc.).
- **NO (basta un clic):** acciones reversibles o de bajo impacto, fáciles de rehacer
  — borrar una cita/horario/recordatorio sueltos, quitar un chat de la vista (regresa
  solo), borrar pasos en el editor con Ctrl+Z, archivar/restaurar, y **desagrupar una
  carpeta sin borrar su contenido**.

**4 · Copia y botón estándar (siempre igual):**
- `title`: **verbo + objeto** → `Eliminar contacto`, `Desconectar WhatsApp`,
  `Revocar token`.
- `message`: una o dos frases — qué se borra + impacto + **"Esta acción no se puede
  deshacer."**. **Nunca** escribas "Escribe ELIMINAR para confirmar" dentro del
  `message`: el Modal ya pinta ese label automáticamente. Duplicarlo = el usuario lo
  ve dos veces (bug).
- `confirmText`: **el verbo** (`Eliminar`, `Desconectar`, `Revocar`, `Generar token`…).
  Esto vuelve el botón **rojo (danger) automáticamente**. Prohibido dejar el default
  `Aceptar` en una confirmación destructiva (ni se pone rojo ni comunica).
- `cancelText`: `Cancelar`.
- El **rojo lo decide solo** el Modal a partir del verbo; no fuerces `variant="danger"`
  salvo en una `secondaryAction` destructiva.

**Snippet canónico (cópialo, no inventes):**
```ts
const { showConfirm } = useNotification()
showConfirm(
  'Eliminar contacto',                                            // title: verbo + objeto
  'Vas a eliminar este contacto y su historial. Esta acción no se puede deshacer.',
  () => deleteContact(id),          // onConfirm — async ok; return false deja el modal abierto en error
  'Eliminar',                       // confirmText: el verbo → botón rojo automático
  'Cancelar',                       // cancelText
  undefined,                        // onCancel
  { typeToConfirm: 'ELIMINAR' },    // por riesgo; OMITE este 7º arg para una confirmación de un solo clic
)
```

`typeToConfirm` **solo** existe dentro del 7º argumento `options`; no es un parámetro
suelto de `showConfirm`. Para `<Modal>` inline es el prop `typeToConfirm="ELIMINAR"`.

**Móvil/Automatizaciones:** la regla es la misma, pero los flujos `Phone*` /
`data-phone-*` no se tocan desde un cambio de escritorio (§5.8).

---

## 5. ⚠️ ERRORES PROHIBIDOS (se rechazan en review — esto ya pasó, no se repite)

1. **Colores rojo/verde hardcodeados para números/estados.** Los `+/-`
   "vs período anterior", ganancias/pérdidas, deltas, dots de estado, etc. usan
   **`var(--pos)` / `var(--neg)`** (verde/rojo afinados por tema). Prohibido
   `#10b981`, `#22c55e`, `#16a34a`, `#dc2626`, `#ef4444`, `text-green-*`,
   `text-red-*`. Excepción: colores de **marca** (Facebook `#1877f2`, etc.).
2. **Controles con fondo transparente / `--bg` / glass.** En Onyx
   `--surface-2` ≈ `--bg`, así que un buscador/tab/segmento con esos fondos se ve
   **vacío**. Los controles sueltos usan `var(--surface)` + `var(--border)`.
3. **Hardcodear hex/rgba** para texto, fondos, bordes, sombras o radios cuando
   hay token. (Bloquea light/dark y las 4 familias.)
4. **Demasiada negrita.** Solo **títulos, números/KPIs, badges y eyebrows**
   van en 600–700. El cuerpo, labels, valores y celdas de tabla van en 400–500.
5. **Reinventar** botones, inputs, tablas, modales, tabs, switches o badges
   cuando ya existe el componente/recipe global.
   En especial, prohibido duplicar `.searchBox`, `.searchInput`,
   `.inputWithIcon`, `.tabs`, `.pill`, `.badge`, `.table` o `.modal` para
   resolver lo mismo que ya existe en `common/`.
6. **Estilos inline en JSX** para cosas que ya tienen clase o token.
7. **Romper los `data-ristak-*`** del shell (sidebar/header/card/table/nav) — el
   re-skin global cuelga de ellos.
8. **Tocar la app móvil (`Phone*`, `data-phone-app`, `data-phone-chat-theme`) o
   Automatizaciones** desde un cambio de diseño de escritorio. Sistema aparte.
9. **Cambiar layout/posición/flujo.** El rediseño es **solo visual**: colores,
   tipografía, tamaños, bordes, sombras, espaciados, jerarquía. No reorganices.
10. **Onyx:** el panel lateral es **siempre oscuro**; su texto/menús deben
    forzar contraste claro en ambos modos (ya hay reglas en `index.css`; no las
    rompas).
11. **Confirmación destructiva fuera del patrón único (§4.1).** Prohibido
    `window.confirm`, un modal de borrado portaleado a mano, o copiar el JSX de
    otro borrado. Prohibido la palabra `typeToConfirm` en minúsculas o que no sea
    el verbo de la acción. Prohibido duplicar "Escribe ELIMINAR para confirmar"
    dentro del `message` (el Modal ya lo pinta). Prohibido `confirmText='Aceptar'`
    en algo destructivo (no se pone rojo). Prohibido ejecutar un borrado
    irreversible/masivo/de integración sin `typeToConfirm`.
12. **`stroke-width` en un `<svg>` contenedor que también envuelve íconos de
    marca rellenos.** Los íconos de `react-icons` (`FaWhatsapp`, `SiWhatsapp`,
    `FaFacebookMessenger`, `FaInstagram`, `Ri*Fill`…) se renderizan con
    `stroke="currentColor"`. Si una regla del contenedor tipo
    `.algoButton svg { stroke-width: N }` los alcanza, les **pinta un contorno
    encima del relleno** y el glifo se ve **grueso / "pixelado"** (esto rompió el
    ícono de WhatsApp del composer y de los badges en el chat móvil `/movil`
    cuando se "adelgazaron" los íconos —`stroke-width` se filtró a los glifos de
    marca). Regla: el `stroke-width` va **solo en el ícono de línea** que lo pide
    (lucide/feather, `fill:none`), **nunca** en un `svg` contenedor que también
    cacha glifos de marca rellenos. Si conviven en el mismo contenedor, deja que
    cada ícono use su `strokeWidth` de atributo (marca = `0`) o fuerza
    `stroke: none; stroke-width: 0` en el glifo de marca. **Verifica íconos
    móviles corriendo la app real (no renders aislados):** un SVG suelto se ve
    fino porque no arrastra esa cascada del contenedor.
13. **Campos numéricos con steppers nativos.** Prohibido `<input type="number">`
    nativo, flechas de subir/bajar del navegador o pseudo-botones equivalentes
    en cualquier superficie de Ristak. Los números se teclean: usa `<NumberInput>`
    en escritorio o una primitiva que renderice `type="text"` con
    `inputMode="numeric"`/`inputMode="decimal"` en móvil. `design:audit` debe
    fallar si aparece un `<input type="number">` nuevo.

---

## 6. Receta canónica de tabla (cuando no se usa `<Table>`)

```css
th  { background: var(--surface-2); color: var(--text-mute);
      font: var(--label-font); font-size: 11px; font-weight: 600;
      text-transform: var(--label-transform); letter-spacing: var(--label-spacing);
      border-bottom: 1px solid var(--border); }
td  { color: var(--text-dim); font-size: 13px; border-top: 1px solid var(--border); }
tr:hover td { background: var(--surface-2); }   /* fila hover */
```
Estado en celda → `<Badge>`. Números → `--num-font`; positivos `--pos`,
negativos `--neg`.

---

## 7. Variantes funcionales permitidas (deben sentirse intencionales)

- **Editor de Sitios (`.rstkCanvas`)**: densidad y controles propios; el CSS
  global ya lo excluye. No lo "arregles" para que parezca formulario normal.
- **Gráficas**: series desde `--accent` / `--accent-2` / `--pos` / `--neg` /
  `--design-chart-*` (mapeados). Grid `--chart-grid`.
- **Marcas de terceros** (Meta/Google/WhatsApp/etc.): su color de marca solo en
  su contexto inmediato.
- **App móvil integrada**: sistema aparte, **prohibido** tocarla.

Si necesitas un patrón nuevo, diséñalo como **extensión del sistema** (tokens +,
si es reutilizable, un componente en `common/` + documéntalo aquí), nunca como
una isla.

---

## 8. Checklist antes de mergear UI nueva

1. Abriste `docs/design-reference/design-system.html` en el navegador
   interno/aislado del agente y tu pantalla se le parece.
2. `<PageContainer>` + `<PageHeader>`; secciones con `gap` ~18px.
3. Solo componentes/recipes globales (§4). Cero `<button>`/`<table>`/modal a mano.
4. Buscadores nuevos con `<SearchField>` o componente especializado; nada de icono
   absoluto + input local.
5. Cero hex/rgba hardcodeados; todo por token (§3). Cero verde/rojo a mano (§5.1).
6. Buscadores/segmentos con fondo `var(--surface)` (visibles en Onyx) (§5.2).
7. Negrita solo en títulos/números/badges (§5.4).
8. Estados de foco/hover/disabled con tokens.
9. **Probado en las 4 familias × claro/oscuro** (Aurora/Onyx/Brut/Nimbus).
10. `npm run design:audit` pasa sin violaciones nuevas.
11. El responsive para ventanas chicas sigue funcionando con reglas fluidas, no
   con estilos visuales paralelos.
12. Toda confirmación de borrar/desconectar/revocar sigue el patrón único (§4.1):
   `showConfirm`/`<Modal type="confirm">`, palabra en MAYÚSCULAS = verbo, copia y
   botón estándar, `typeToConfirm` por riesgo. Cero `window.confirm` y cero modales
   de borrado a mano.
13. Los campos numéricos no usan `<input type="number">` nativo ni muestran
    flechas de subir/bajar.
14. No tocaste `Phone*`, Automatizaciones, ni el layout/flujo.
