# 🎨 Referencia de diseño de Ristak (escritorio)

Este folder es la **fuente visual de verdad** del sistema de diseño global de Ristak.
Es el ZIP de diseño original, versionado en el repo a propósito: **cada vez que
implementes una función o pantalla nueva, ábrelo y replica este lenguaje visual.**

## Qué hay aquí

| Archivo | Qué es | Cómo usarlo |
| --- | --- | --- |
| **`design-system.html`** | El playground completo del sistema: TODOS los componentes (botones, badges, inputs, buscadores, tabs, cards, tablas, modales, date-picker, switch, radios…), las **4 familias** de tema (Aurora / Onyx / Brut / Nimbus) con sus variantes, y TODAS las pantallas (Dashboard, Chat, Citas, Pagos, Contactos, Reportes, Analíticas, Publicidad, Sitios, Agente AI, Configuración) en claro y oscuro. | **Ábrelo en un navegador** (doble clic). Usa el selector de arriba para cambiar de familia/variante/modo y mira cómo se ve CADA componente y pantalla. Es lo que tu UI nueva debe parecer. |
| `support.js` | Motor que renderiza el playground. | No lo edites; lo necesita el HTML. |
| `screenshots/` | Capturas de las variantes y estados (charthover, datepicker, onyx, dark, etc.). | Comparación rápida sin abrir el HTML. |
| `logos/`, `uploads/`, `RISTAK LOGO.svg` | Assets de marca que usa el playground. | — |
| `frontend/` | ⚠️ **Snapshot de código VIEJO** de cuando se hizo el diseño. | **NO copies código de aquí.** Está obsoleto. El código vivo en `/frontend/src` es la única fuente de verdad para implementar. Esta carpeta solo sirve para ver el diseño objetivo. |

## La regla

> El diseño ya está implementado en el código (tokens en
> `frontend/src/styles/index.css` + componentes en
> `frontend/src/components/common/`). **Este folder es el "por qué" / el objetivo
> visual; el código es el "cómo".** Si tu pantalla nueva no se parece a lo que se
> ve en `design-system.html`, está mal.

Reglas obligatorias y estrictas: **[`../DESIGN_SYSTEM.md`](../DESIGN_SYSTEM.md).**
