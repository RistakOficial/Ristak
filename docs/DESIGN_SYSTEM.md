# Sistema de diseño de Ristak (web de escritorio)

> **Léeme antes de tocar UI.** Si vas a crear una pantalla, componente o flujo
> visual nuevo, primero revisa esta guía y los componentes existentes en
> `frontend/src/components/common/`. La congruencia de marca y diseño se
> respeta siempre, aunque la funcionalidad sea nueva. No inventes diseños
> nuevos sin revisar primero los tokens globales y los patrones existentes.

## 1. Estética general

Ristak de escritorio es un SaaS **minimalista, monocromático, sobrio, elegante
y profesional**:

- Paleta monocromática slate (`--color-primary: #64748b` dark / `#475569`
  light) sobre fondos neutros. El color saturado se reserva para **semántica**
  (success/warning/error) y para **variantes funcionales justificadas** (§6).
- Bordes de 1px sutiles (`rgba(148, 163, 184, 0.14–0.32)`), sin sombras
  llamativas. La sombra más fuerte permitida en superficies es del estilo
  `0 10px 24px -20px rgba(15, 23, 42, 0.45)` (flotantes: dropdowns, menús).
- Sin gradientes decorativos nuevos. Los únicos gradientes vivos son los de
  los tokens existentes (`--gradient-*`) y los rellenos de gráficas.
- Densidad cómoda pero compacta: una herramienta de trabajo, no una landing.

## 2. Dónde vive el sistema

| Pieza | Archivo |
| --- | --- |
| Tokens CSS (colores, espaciado, radios, tipografía, z-index, controles) | `frontend/src/styles/index.css` (`:root` y `body[data-design-preset]`) |
| Skin global de formularios nativos (input/select/checkbox/radio/date) | `frontend/src/styles/index.css` (secciones "RISTAK NATIVE CONTROL SKIN" y selectores `body:not([data-phone-app])`) |
| Presets de diseño (classic / atelier / editorial) | `frontend/src/styles/index.css` (`body[data-design-preset='…']`) + `ThemeContext` |
| Tokens TS para gráficas/temas | `frontend/src/theme/tokens.ts` |
| Componentes compartidos | `frontend/src/components/common/` |

**Regla de oro:** si un valor existe como token (`var(--…)`), úsalo. No
hardcodees colores hex/rgba nuevos ni tamaños improvisados.

## 3. Jerarquía tipográfica canónica

| Nivel | Especificación | Cómo se obtiene |
| --- | --- | --- |
| Título de página | 24px / peso 760 / line-height 1.15 | `<PageHeader title …/>` |
| Eyebrow (etiqueta sobre el título) | 11px / 760 / uppercase / terciario | `<PageHeader eyebrow …/>` |
| Subtítulo de página | 13px / secundario | `<PageHeader subtitle …/>` |
| Título de panel de Settings (icono + estado) | 18px / 700 + descripción 14px terciaria/secundaria | receta "panel header" (icono 42×42 r8 `rgba(148,163,184,.12)` + borde `.18`) |
| Título de card / sección | 18px (`--font-size-lg`) / semibold | clase local o `text-lg font-semibold` |
| Título de card compacta (stat lists) | 16px / semibold | `text-base font-semibold` |
| Encabezado de tabla | 12px (`--font-size-xs`) / semibold / uppercase / terciario | receta de tabla (§5) |
| Cuerpo | 13–14px (`--font-size-sm`) | por defecto |
| Texto auxiliar | 12px terciario | — |

No introduzcas tamaños nuevos de título. Si dudas entre dos niveles, usa el
más pequeño (sobriedad).

## 4. Patrones que SIEMPRE se reutilizan

- **Header de página** → `<PageHeader eyebrow? title subtitle? actions?/>`.
  Es el header canónico: título a la izquierda, acciones a la derecha,
  borde inferior sutil. Todas las páginas de escritorio lo usan (Dashboard,
  Contactos, Pagos, Publicidad, Reportes, Analíticas, Calendarios, Sites,
  Settings). Acepta atributos `data-*` (los presets de diseño se cuelgan de
  ellos, p. ej. `data-dashboard-heading`).
- **Contenedor de página** → `<PageContainer>` (`size="wide"` para reportes).
  Padding y ancho máximo (`--app-page-max`) salen de ahí; no los redefinas.
- **Ritmo vertical de página** → 18px de `gap` entre secciones principales.
- **Botones** → `<Button variant="primary|secondary|ghost|danger|outline">`.
  No crees `<button>` con estilos propios para acciones estándar; si un botón
  local es inevitable, usa los tokens `--design-control-*` (altura 40px,
  radio `--design-control-radius`, borde `--design-control-border`).
- **Inputs/selects/textarea/checkbox/radio/date** → ya están skineados
  globalmente. Un `<input type="text">` plano hereda el sistema. Escape hatch:
  `data-ristak-unstyled` (solo para variantes funcionales, §6).
- **Tablas** → `<Table>` (`components/common/Table`): búsqueda, columnas
  configurables, paginación, skeleton. Solo se escribe una `<table>` manual si
  la interacción no cabe en el componente, y entonces debe copiar la receta §5.
- **Cards** → `<Card padding variant>`; KPIs → `<KpiCard>`. Llevan
  `data-ristak-card` / `data-ristak-kpi-card`, que los presets necesitan.
- **Tabs/filtros** → `<TabList>`; selects enriquecidos → `<CustomSelect>`;
  menús → `<DropdownMenu>`; badges → `<Badge variant>`; modales → `<Modal>`;
  loading → `<Loading>`/skeleton del propio componente; toasts → `<Toast>`.
- **Estados de foco** → `--ristak-focus-border` + `--ristak-focus-ring`.
  Nunca un ring de color hardcodeado.
- **Chips de estado** (Conectado / Sin conexión / etc. en Settings) → receta
  local consistente: pill 32px, 12px/650, fondos `rgba(status, 0.08–0.11)`.

## 5. Receta canónica de tabla (cuando no se usa `<Table>`)

```css
th {
  background: var(--design-table-head-bg, var(--color-surface));
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--design-table-header-spacing, 0.025em);
  text-transform: uppercase;
  border-bottom: 1px solid var(--design-table-border, rgba(148, 163, 184, 0.18));
}
td {
  color: var(--color-text-secondary);   /* primario para la columna principal */
  font-size: 13px;                       /* 13–14px */
  border-top: 1px solid var(--design-table-border, rgba(148, 163, 184, 0.14));
}
```

Acciones de fila: iconos 32×32 con borde sutil, jerarquía
secundaria → primaria al hover; destructivas en `--color-status-error` solo
al hover. Hover de fila: `rgba(148, 163, 184, 0.055)` aprox.

## 6. Variantes funcionales permitidas

Una función especial **puede** desviarse del patrón global cuando el patrón
empeoraría la UX, pero la desviación debe sentirse **intencional** y conservar
la estética (mismos radios, bordes, tipografía base):

- **Editor de sitios (`Sites`)**: canvas (`.rstkCanvas`), paletas de colores,
  controles de bloques, reordenamiento de páginas, previews. Tiene densidad
  propia (12–14px) y controles visuales especiales. El CSS global de
  formularios ya lo excluye; no "arregles" sus controles para que parezcan
  formularios normales.
- **Liveboard / gráficas**: colores de series desde `--design-chart-*`.
- **Calendario (Appointments)**: los estados de cita usan codificación por
  color (confirmada azul, pendiente ámbar, cancelada roja, asistió verde,
  no-show gris, reagendada violeta). Es semántica funcional, no decoración.
- **Documentación de API**: badges GET/POST/PUT/PATCH/DELETE con los colores
  convencionales de la industria.
- **Marcas de terceros**: logos y switches de Meta/Google/WhatsApp pueden usar
  el color de la marca en su contexto inmediato (p. ej. switch de píxel Meta).
- **App móvil integrada (`Phone*`, `data-phone-app`, `data-phone-chat-theme`)**:
  sistema aparte, **prohibido** tocarla desde cambios de escritorio.

Si necesitas un patrón nuevo, diséñalo como **extensión del sistema** (usa los
tokens, agrégalo a `components/common/` si es reutilizable y documenta aquí la
variante), nunca como un diseño independiente.

## 7. Qué evitar (lista corta de rechazo en review)

- Sombras exageradas, glows, gradientes decorativos.
- Colores fuera de paleta hardcodeados (azul `#3b82f6`, teal `#14b8a6`, etc.)
  para foco/acentos: usa `--color-primary` / `--ristak-focus-ring` / tokens de
  status.
- Títulos con tamaños/pesos improvisados (36px, 800…) o headers de página
  hechos a mano en vez de `<PageHeader>`.
- `<table>`, botones, inputs o modales re-estilizados desde cero cuando ya
  existe componente o receta.
- Estilos inline en JSX para cosas que ya tienen clase o token.
- Declarar en `:root` alias que referencien tokens temados (p. ej.
  `--mi-alias: var(--color-background-secondary)`): las custom properties
  sustituyen sus `var()` donde se declaran, así que el alias queda congelado
  con los defaults oscuros aunque `body.light` cambie el token base. Esos
  alias se declaran en `body` (ver el bloque `body { --ristak-dropdown-* }`
  en `styles/index.css`).
- Páginas que "parecen de otra app": antes de mergear, compara tu pantalla
  con Dashboard/Contactos y con esta guía.
- Romper los atributos `data-ristak-*` (los presets de diseño dependen de
  ellos).

## 8. Checklist para nuevas pantallas

1. `<PageContainer>` + `<PageHeader>`.
2. Secciones con `gap` de 18px; cards con `<Card>`.
3. Formularios con elementos nativos (ya skineados) + `<Button>`.
4. Tablas con `<Table>` o la receta §5.
5. Estados vacíos: icono terciario + texto 13px secundario + acción.
6. Hover/focus/disabled con tokens; nada de rings de colores.
7. Probar en dark y light, y con los presets atelier/editorial activados.
8. No tocar `Phone*` ni el canvas del editor.
