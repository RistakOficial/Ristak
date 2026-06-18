# Codex Instructions

## UI / diseño — OBLIGATORIO

- **ALTO antes de tocar UI.** Antes de crear o modificar CUALQUIER pantalla,
  componente, estilo o función con interfaz del frontend de escritorio:
  1. Lee **`docs/DESIGN_SYSTEM.md`** completo (reglas estrictas / lista de rechazo).
  2. Abre **`docs/design-reference/design-system.html`** en un navegador y mira
     cómo se ve ese componente/pantalla (4 familias, claro/oscuro, todas las
     pantallas y componentes). Tu UI nueva debe parecerse a eso.
  3. Reutiliza los componentes de `frontend/src/components/common/` y los **tokens**
     de `frontend/src/styles/index.css`. No inventes estilos.
- **No negociable** (detalle en `docs/DESIGN_SYSTEM.md`): nada de hex/rgba
  hardcodeados (usa tokens `--bg/--surface/--text/--accent/--pos/--neg/--radius-*/
  --shadow-*`); `+/-` y estados con `var(--pos)`/`var(--neg)`, nunca verde/rojo a
  mano; buscadores/segmentos con fondo `var(--surface)` (transparente se ve vacío en
  Onyx); negrita solo en títulos/números/badges; probar en las 4 familias ×
  claro/oscuro; **no cambiar layout/posición/flujo** (solo lo visual).
- La app móvil integrada (`Phone*`, `data-phone-app`, `data-phone-chat-theme`) y
  Automatizaciones tienen su propio sistema visual y quedan fuera de los cambios
  de diseño de escritorio.

## Git publishing

- `main` is the only base and publish target for this repo.
- Do not switch, cherry-pick, or push any other branch as part of publishing.
- Do not include unrelated local changes when syncing branches.
