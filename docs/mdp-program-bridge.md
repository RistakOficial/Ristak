# Magnetismo de Pacientes bridge

Esta integracion permite mostrar Magnetismo de Pacientes dentro de Ristak sin convertir Ristak en una plataforma de cursos generica.

Ristak solo hace tres cosas:

1. Respeta el feature general `mdp_program`.
2. Pide a MDP el menu dinamico del alumno.
3. Embebe la seccion elegida con un launch token emitido por MDP.

MDP sigue siendo la fuente de verdad de cursos, mentorias, recursos y permisos internos.

## Variables

```env
MDP_PROGRAM_API_URL=https://tu-mdp.com
MDP_PROGRAM_BRIDGE_SECRET=...
```

`MDP_PROGRAM_BRIDGE_SECRET` debe coincidir con `RISTAK_APP_BRIDGE_SECRET` o `MDP_PROGRAM_BRIDGE_SECRET` en MDP.

## Flujo en Ristak

- El Installer sincroniza la licencia con `mdp_program=true`.
- El sidebar muestra `Magnetismo`.
- Ristak llama `GET /api/mdp-program/navigation`.
- El backend de Ristak firma un POST hacia MDP: `/api/ristak/navigation`.
- MDP devuelve las pestañas disponibles para ese usuario.
- Al abrir una seccion, Ristak refresca el manifest para usar un launch token nuevo y carga MDP en un iframe.

## Archivos de esta integracion

- `backend/src/services/mdpProgramBridgeService.js`
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
7. Quitar `MdpProgramNavGroup` y sus imports/estado en `Sidebar.tsx`.
8. Quitar las variables `MDP_PROGRAM_*` del entorno.
