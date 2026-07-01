# Codex Instructions

## Fechas y zonas horarias — OBLIGATORIO

- **ALTO antes de tocar fechas.** Antes de crear o modificar cualquier lógica de
  fechas, horas, rangos, crones, pagos programados, citas, contactos, anuncios,
  reportes, sitios, formularios, mensajes programados o integraciones externas,
  lee **`docs/DATE_TIME_GUIDELINES.md`** completo.
- Regla base: la zona horaria del negocio manda. La base guarda instantes en UTC,
  las fechas de calendario se interpretan en la zona del negocio, y el frontend no
  debe depender de la zona horaria del navegador para datos del CRM.
- No uses `new Date().toISOString().slice(0, 10)`, `DateTime.local()`,
  `DateTime.now().toISODate()` ni conversiones manuales para fechas de negocio.
  Usa `backend/src/utils/dateUtils.js` y `frontend/src/utils/timezone.ts`.

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
- **Religión de componentes globales.** Si existe o se repite un patrón
  (buscador, botón, input con icono, tabs, card, tabla, modal, badge, menú,
  etiqueta/pill), usa o extiende `frontend/src/components/common/` y los tokens
  globales. No crees CSS local tipo `.searchBox`, `.searchInput`, `.tabs`,
  `.badge`, `.modal`, etc. para resolver lo mismo en una página.
- **Auditoría obligatoria.** Antes de cerrar cualquier cambio de UI de escritorio,
  corre `cd frontend && npm run design:audit`. Si falla, migra al componente
  global correcto. No agregues archivos a la allowlist del auditor salvo que sea
  deuda legacy ya existente y quede explícitamente justificado en el cambio.
- **Responsive sí importa.** Mantén layouts fluidos para compus chicas usando
  `flex`, `grid`, `minmax`, `clamp`, `min-width: 0`, container/media queries y
  variables del componente. No confundas responsive con inventar otra identidad
  visual aislada por pantalla.
- La app móvil integrada (`Phone*`, `data-phone-app`, `data-phone-chat-theme`) y
  Automatizaciones tienen su propio sistema visual y quedan fuera de los cambios
  de diseño de escritorio.

## Backend / integraciones con crons — OBLIGATORIO

- Si agregas una integración externa que requiera un cron, job periódico,
  watchdog, polling o reintento automático, primero lee
  **`docs/INTEGRATION_CRON_RULES.md`**.
- Regla central: un cron que depende de una integración externa NO debe arrancar
  sólo porque el backend arrancó. Debe activarse únicamente cuando esa
  integración esté conectada localmente y apagarse al desconectarla.
- Los crons de sistema sí pueden vivir siempre activos; los crons de
  integraciones deben registrarse en `backend/src/jobs/integrationCronRegistry.js`
  y evaluarse con detectores locales en
  `backend/src/services/integrationConnectionStateService.js`.
- Al conectar, desconectar o cambiar modo relevante de una integración, el
  controller debe llamar `syncRegisteredIntegrationCronsForProvider(...)` para
  prender/apagar el cron sin reiniciar el backend.

## Documentación — OBLIGATORIO

- Antes de crear, mover o modificar documentación, lee **`docs/README.md`** y
  **`docs/DOCUMENTATION_SYSTEM.md`**.
- Para cualquier cambio de producto, arquitectura, rutas, servicios, tablas,
  permisos, licencias, pagos, integraciones, jobs, IA, app móvil, Sites, tracking
  o comportamiento visible, actualiza la sección correspondiente en
  **`docs/RISTAK_MASTER_MANUAL.md`** o el documento especializado indicado en
  `docs/README.md`.
- Si agregas un documento nuevo, debe quedar enlazado en **`docs/README.md`** y
  explicado en **`docs/DOCUMENTATION_SYSTEM.md`** si introduce una ruta nueva de
  mantenimiento.
- Nunca documentes valores reales de secrets, tokens, contraseñas, connection
  strings, certificados o claves privadas. Documenta sólo nombre, ubicación,
  propósito y si es obligatorio para arrancar.
- En el resumen final de cada implementación, menciona qué documentación
  actualizaste o por qué no aplicaba actualizar documentación.

## Git publishing

- `main` is the only base and publish target for this repo.
- Do not switch, cherry-pick, or push any other branch as part of publishing.
- Do not include unrelated local changes when syncing branches.
