# Codex Instructions

## UI / diseño

- Antes de crear o modificar cualquier pantalla, componente o estilo del
  frontend de escritorio, lee `docs/DESIGN_SYSTEM.md` y reutiliza los
  componentes de `frontend/src/components/common/` y los tokens de
  `frontend/src/styles/index.css`. No inventes estilos nuevos (colores,
  tamaños de título, sombras, tablas o headers propios) sin pasar por esa guía.
- La app móvil integrada (`Phone*`, `data-phone-app`) tiene su propio sistema
  visual y queda fuera de los cambios de diseño de escritorio.

## Git publishing

- `main` is the only base and publish target for this repo.
- Do not switch, cherry-pick, or push any other branch as part of publishing.
- Do not include unrelated local changes when syncing branches.
