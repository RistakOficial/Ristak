# CLAUDE.md — Ristak

> Documento historico para Claude. La regla vigente para agentes vive en
> [`AGENTS.md`](AGENTS.md); el sistema canonico de documentacion empieza en
> [`docs/README.md`](docs/README.md).

## 🛑 Diseño / UI — LÉEME ANTES DE TOCAR CUALQUIER INTERFAZ

Ristak tiene **un sistema de diseño global obligatorio**. Cada función o pantalla
nueva DEBE usarlo — no hay excepción de "es nueva".

**Antes de crear o modificar cualquier UI de escritorio:**

1. Lee **[`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md)** completo (reglas
   estrictas + lista de rechazo en review).
2. Abre **`docs/design-reference/design-system.html`** en el navegador
   interno/aislado disponible para el agente; **no abras Google Chrome ni el
   navegador personal del usuario** salvo que el usuario lo pida explícitamente.
   Si `file://` queda bloqueado, sirve `docs/design-reference/` por `127.0.0.1`
   desde el worktree y abre esa URL interna. Mira cómo debe verse ese
   componente/pantalla (las 4 familias de tema Aurora/Onyx/Brut/Nimbus,
   claro/oscuro, todos los componentes y pantallas).
   **Si tu UI no se parece a eso, está mal.**
3. Reutiliza los componentes de `frontend/src/components/common/` y los **tokens**
   de `frontend/src/styles/index.css`. **No inventes estilos.**

**Reglas duras (todas detalladas en `docs/DESIGN_SYSTEM.md`):**

- Cero hex/rgba hardcodeados. Usa tokens: `--bg --surface --surface-2 --text
  --text-dim --text-mute --border --accent --accent-soft --pos --neg --warn
  --info --radius-card --radius-ctl --shadow-card`. Cambian solos por familia/modo.
- Números/estados `+/-` → `var(--pos)` / `var(--neg)`. **Nunca** verde/rojo a mano.
- Buscadores y controles → fondo `var(--surface)` + `var(--border)`. Nada de
  `transparent`/`--bg`/glass (se ven vacíos en Onyx).
- Negrita solo en títulos, números/KPIs y badges. Cuerpo en 400–500.
- Reutiliza: `Button`, `Badge`, `TabList`, `SegmentTabs`, `Switch`, `Modal`,
  `ContactSearchInput`/`GlobalSearch`, `CustomSelect`, `Card`, `KpiCard`, `Table`,
  `PageHeader`, `PageContainer`. Estados → `utils/statusBadges` + `<Badge>`.
- **Prueba en las 4 familias × claro/oscuro** (sobre todo Onyx).
- Rediseño = **solo visual**: no cambies layout, posición ni flujo.
- No toques `Phone*` / `data-phone-*` ni Automatizaciones desde diseño de escritorio.

## Otras convenciones

- `AGENTS.md` tiene las reglas de git/publishing (`main` es el único target).
- App: frontend Vite (`frontend/`, dev `:3000`) + backend Node/SQLite
  (`backend/`, `:3001`). Sin secretos en el repo.
