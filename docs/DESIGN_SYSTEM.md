# 🛑 SISTEMA DE DISEÑO DE RISTAK — REGLAS OBLIGATORIAS (escritorio)

> ## ALTO. LÉEME ANTES DE TOCAR UI.
>
> Si vas a crear o modificar **cualquier** pantalla, componente, estilo o
> función que tenga interfaz, **es OBLIGATORIO** que:
>
> 1. **Abras `docs/design-reference/design-system.html`** en un navegador y veas
>    cómo se ve el componente/pantalla que vas a tocar (ahí está TODO: los 4
>    temas, todos los componentes y todas las pantallas en claro y oscuro).
> 2. **Reutilices** los componentes de `frontend/src/components/common/` y los
>    **tokens** de `frontend/src/styles/index.css`. No inventes nada.
> 3. **Pruebes tu cambio en las 4 familias × claro/oscuro** antes de darlo por
>    hecho (sobre todo **Onyx**, que destapa bugs de contraste).
>
> La congruencia de marca **no es negociable**, aunque la función sea nueva.
> Una pantalla que "parece de otra app" se **rechaza en review**. No hay excusa
> de "es una función nueva": las funciones nuevas también usan el diseño global.

La referencia visual vive en **[`docs/design-reference/`](design-reference/)**
(ábrela). El código que la implementa vive en `frontend/src/styles/index.css`
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
| **Nimbus** | `a` | Limpio, profesional, neutro frío |

- El usuario elige familia/variante/modo en el **menú de usuario del sidebar**;
  el motor está en `frontend/src/contexts/ThemeContext.tsx` (atributo `data-dir`
  en `<body>`, modo con clase `.light/.dark`, persistido en `theme_dir`).
- **Tu UI debe verse correcta en TODAS las familias automáticamente.** Eso solo
  pasa si usas tokens (§3). Si hardcodeas un color, se rompe en alguna familia.

---

## 2. Dónde vive el sistema

| Pieza | Archivo |
| --- | --- |
| **Referencia visual (ÁBRELA)** | `docs/design-reference/design-system.html` |
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

| Necesitas… | Usa | Nunca |
| --- | --- | --- |
| Botón | `<Button variant="primary\|secondary\|ghost\|danger">` | `<button>` con estilos propios |
| Etiqueta de estado / badge | `<Badge variant=…>` (+ `utils/statusBadges`) | un `span` "pill" con colores a mano |
| Buscador | `<ContactSearchInput>` / `<GlobalSearch>` / receta `[data-fld]` (fondo `var(--surface)`, borde `var(--border)`, radio `var(--radius-ctl)`) | un input con fondo `transparent`/`--bg`/glass (¡desaparece en Onyx!) |
| Tabs segmentados (en card) | `<TabList>` | rgba hardcodeados |
| Tabs de sub-sección (underline) | `<SegmentTabs>` (recipe `[data-segdir]`) | un nav a mano |
| Switch / toggle | `<Switch>` (recipe `[data-sw]`) | un checkbox estilizado a mano |
| Select enriquecido | `<CustomSelect>` | — |
| Menú | `<DropdownMenu>` | — |
| Modal / overlay | `<Modal>` (recipe `[data-overlay]`/`[data-modal]`) | un `position:fixed` a mano |
| Card / KPI | `<Card>` / `<KpiCard>` (llevan `data-ristak-card`) | — |
| Tabla | `<Table>` (o la receta §6) | una `<table>` desde cero |
| Header / contenedor de página | `<PageHeader>` / `<PageContainer>` | un header a mano |
| Inputs nativos | ya están skineados globalmente; un `<input>` plano hereda el sistema | re-estilizarlos |

Foco: `--ristak-focus-ring` / borde `--accent`. **Nunca** un ring de color a mano.

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

1. Abriste `docs/design-reference/design-system.html` y tu pantalla se le parece.
2. `<PageContainer>` + `<PageHeader>`; secciones con `gap` ~18px.
3. Solo componentes/recipes globales (§4). Cero `<button>`/`<table>`/modal a mano.
4. Cero hex/rgba hardcodeados; todo por token (§3). Cero verde/rojo a mano (§5.1).
5. Buscadores/segmentos con fondo `var(--surface)` (visibles en Onyx) (§5.2).
6. Negrita solo en títulos/números/badges (§5.4).
7. Estados de foco/hover/disabled con tokens.
8. **Probado en las 4 familias × claro/oscuro** (Aurora/Onyx/Brut/Nimbus).
9. No tocaste `Phone*`, Automatizaciones, ni el layout/flujo.
