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

- When pushing changes to `main`, also push the same completed change to `test`.
- If the same patch already exists on `test`, still run `git push origin test` and report that it was already up to date.
- Do not include unrelated local changes when syncing branches.
