# Magnetismo de Pacientes bridge

Esta integracion permite mostrar Magnetismo de Pacientes dentro de Ristak sin convertir Ristak en una plataforma de cursos generica.

Ristak solo hace tres cosas:

1. Respeta el feature general `mdp_program`.
2. Respeta `licenseExternalModules.mdp_program.sidebarPosition` para ubicar el modulo en el sidebar.
3. Pide a MDP un launch token autorizado para el alumno.
4. Embebe MDP en pantalla completa dentro del area principal de Ristak.

MDP sigue siendo la fuente de verdad de cursos, mentorias, recursos, pestañas internas y permisos internos.

## Alta comercial desde productos Ristak

Un producto puede apuntar su webhook POST a `/api/webhooks/mdp` de Cursos y
guardar el token de MDP como `Authorization: Bearer ...`. Cada precio del
producto debe tener el mismo SKU configurado en el paquete activo de MDP.

Ristak envía el contrato `ristak.product-payment.v1`: mantiene el sobre completo
del pago y además publica `email`, `payment_id`, `payment_mode` y el `SKU` del
precio exacto como campos de raíz. MDP también entiende el sobre anidado anterior
(`contact.email`, `payment.id`, `lineItem.priceId` y `product.prices`) para que el
orden de despliegue entre los dos servicios no corte las altas.

Los pagos `test|sandbox` sirven para validar autorización, contacto, SKU, paquete
y oferta privada. MDP responde `test_validated`, pero no crea alumnos ni activa
productos. Sólo los pagos `live|production` preparan el acceso comercial y los
módulos empiezan su vigencia en el primer ingreso del alumno.

## Variables

```env
MDP_PROGRAM_API_URL=https://tu-mdp.com
MDP_PROGRAM_BRIDGE_SECRET=...
```

`MDP_PROGRAM_BRIDGE_SECRET` debe coincidir con `RISTAK_APP_BRIDGE_SECRET` o `MDP_PROGRAM_BRIDGE_SECRET` en MDP.

## Flujo en Ristak

- El Installer sincroniza la licencia con `mdp_program=true`.
- El Installer envia `external_modules.mdp_program.sidebar_position` en la licencia.
- El sidebar usa esa posicion como ancla y muestra un solo bloque `Magnetismo` con separador.
- Ristak llama `GET /api/mdp-program/navigation`.
- El backend de Ristak firma un POST hacia MDP: `/api/ristak/navigation`.
- MDP devuelve las secciones disponibles para ese usuario y sus launch URLs.
- Ristak abre la primera seccion autorizada en un iframe de ancho y alto completo.
- Cuando MDP navega dentro del iframe, emite `postMessage` con `type: "ristak:navigation"` y `path` interno (`/curso`, `/curso/leccion/:id`, `/mentoria`, etc.). Ristak traduce eso a `/mdp-program/:itemId/...` para que refresh, copiar URL o abrir una pestana nueva conserve la pantalla exacta.

Ejemplo: si MDP esta en `/curso/leccion/abc`, Ristak muestra `/mdp-program/curso/leccion/abc`. Al refrescar, Ristak pide un launch token nuevo y lo relanza con `to=/curso/leccion/abc`.

## Sincronizacion visual

Cuando Ristak abre el iframe, agrega parametros `embedded=ristak`, `ristak_theme_mode`, `ristak_theme_dir` y `ristak_theme_preset` al launch URL de MDP.

Despues de cargar el iframe, Ristak tambien envia `postMessage` con `type: "ristak:theme"` cada vez que cambia el modo claro/oscuro o la familia visual. MDP aplica ese tema en memoria mientras esta embebido y no debe guardar esa preferencia como tema propio del curso.

## Archivos de esta integracion

- `backend/src/services/mdpProgramBridgeService.js`
- `backend/src/services/licenseService.js`
- `backend/src/controllers/authController.js`
- `backend/src/routes/mdpProgram.routes.js`
- `backend/src/server.js`
- `frontend/src/services/mdpProgramService.ts`
- `frontend/src/pages/MDPProgram/`
- `frontend/src/App.tsx`
- `frontend/src/components/layout/Sidebar/Sidebar.tsx`
- `.env.example`

## Como quitarla

1. Quitar el mount `/api/mdp-program` en `backend/src/server.js`.
2. Borrar `backend/src/routes/mdpProgram.routes.js`.
3. Borrar `backend/src/services/mdpProgramBridgeService.js`.
4. Quitar `MDPProgram` y la ruta `mdp-program/*` en `frontend/src/App.tsx`.
5. Quitar `frontend/src/services/mdpProgramService.ts`.
6. Borrar `frontend/src/pages/MDPProgram/`.
7. Quitar `MdpProgramSidebarBlock`, el item `mdp_program` y sus imports en `Sidebar.tsx`.
8. Quitar `licenseExternalModules` si solo se usaba para MDP.
9. Quitar las variables `MDP_PROGRAM_*` del entorno.
