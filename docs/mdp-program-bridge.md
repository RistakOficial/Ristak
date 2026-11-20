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

## Asociación informativa de pagos con inscripciones existentes

Este flujo es independiente del webhook comercial anterior. Conserva el pago,
el plan y los accesos originales: no da altas, cobra, envía mensajes, cambia
fechas ni suspende alumnos. Tampoco interpreta un intento fallido aislado como
deuda ni equipara el fin de un calendario financiero con el fin del acceso.

La migración aditiva `170_program_payment_associations.sql` crea:

- `program_payment_product_mappings`: relación explícita entre el ID **local**
  de un producto Ristak y el ID de un programa Magnetismo verificado. Dos
  productos con nombres similares requieren decisiones independientes. No se
  infieren equivalencias por importe, duración o SKU vacío.
- `program_payment_associations`: referencia única por pago o plan a un contacto,
  alumno e inscripción existente, con revisión de la evidencia y clasificación.
- `program_payment_association_events`: auditoría de cada alta de vínculo y su
  actor, razón y huella, en la misma transacción que el vínculo. Conserva el
  historial aunque desaparezca el pago/contacto/producto. No guarda recibos,
  notas, cuerpos de mensajes, credenciales ni el contenido del progreso.

Las siete herramientas MCP `payments_program_*` se descubren con
`mcp_search_capabilities`. Todas requieren administrador y el scope existente
`ristak.read` o `ristak.write`, además del permiso del módulo Pagos. Consultar
planes sigue respetando la licencia `payment_plans`; no se agregan permisos.

1. Consultar catálogo y programa; preparar `payments_program_mapping_create`
   con `productId`, `programId` y `reason`. Su default es `dryRun=true`.
   Para guardar, repetir con `dryRun=false` y una clave de idempotencia nueva.
2. Recorrer `payments_program_review` con `sourceType=payment` y después `plan`.
   Cada página tiene hasta 100 fuentes, `hasMore` y `nextAfterId`. Cada revisión
   diaria completa empieza sin cursor; no reutilizar eternamente el último ID,
   pues pagos y planes existentes pueden cambiar. Los eventos del inbox MCP
   sirven como avisos de fuentes concretas que siempre deben releerse.
3. Usar `payments_program_link_preview` para una fuente. Sólo una referencia
   explícita y coherente a un producto mapeado permite continuar automáticamente.
   La descripción orienta la revisión, pero no demuestra producto, duración ni
   condiciones comerciales. Una consulta individual o una fuente sin producto
   requiere decisión del usuario; no basta que Marco ya sea alumno. Si decide
   asociarla, incluir `decision={confirmed:true,productId,reason}` únicamente
   para esa fuente exacta. Productos mezclados, referencias incompatibles y
   estados/modos desconocidos quedan bloqueados. No se reparte un pago entre
   varios programas.
4. La vista previa consulta `get_student({email})` en el MCP de Magnetismo.
   Exige un contacto Ristak activo con correo exacto único, un alumno activo con
   el mismo correo y una inscripción del programa con estado conocido. No usa
   nombres, teléfonos, búsqueda parcial, alias de correo ni un alta comercial
   para resolver identidad. Varias inscripciones requieren `enrollmentId`.
   Puede asociar una inscripción vencida o pausada conservando ese estado.
5. Aplicar `payments_program_link` con `dryRun=false`, `expectedFingerprint`
   recién obtenido, los mismos argumentos de decisión/inscripción y una clave
   de idempotencia nueva. Relee evidencia y destino, rechaza cambios y no
   reasigna vínculos existentes. Plan y pagos ligados por relaciones canónicas
   deben apuntar al mismo producto/alumno/inscripción. Inserción y auditoría son
   atómicas; la unicidad durable evita duplicados aun después de caducar la
   caché MCP. PostgreSQL usa un snapshot serializable y aborta ante conflictos.
6. `payments_program_links_list` lista vínculos por páginas.
   `payments_program_link_context` relee estados y cuotas; con
   `includeProgress=true` añade avance observado, último video y siguiente paso.
   Ver un video no demuestra haber completado un trabajo. Un cambio de correo
   o identidad exige revisión y no reasigna el alumno.

Los resúmenes conservan moneda e importes originales sin sumarlos ni convertirlos.
Los vencimientos `YYYY-MM-DD` conservan su fecha de negocio y se identifican como
`business_date`; los timestamps almacenados completos se publican como instantes
UTC (`utc_instant`). Las fechas y estados de acceso se informan por separado.
El progreso y el acceso son observaciones remotas, no una transacción distribuida
con Magnetismo. Una revisión posterior vuelve a verificar el estado actual.

### Conexión de consulta y activación

El cliente usa exclusivamente una **llave MCP ya existente** del administrador:

```env
MDP_PAYMENTS_MCP_URL=https://tu-mdp.com/mcp
MDP_PAYMENTS_MCP_TOKEN=
```

Estas variables opcionales se configuran en el backend por el propietario de la
conexión. No reutilizar `MDP_PROGRAM_BRIDGE_SECRET`: autoriza otro contrato. No
crear ni rotar una llave para completar esta integración sin autorización; las
llaves guardadas como hash en Magnetismo no se pueden recuperar. Ausencia de
configuración produce `target_not_configured`; la revisión local sigue disponible.

Se fija el endpoint HTTPS `/mcp`, se rechazan redirects y sólo se permiten las
consultas `get_course_tree`, `get_student` y `get_student_progress`. Cada consulta
tiene límite de ocho segundos y 2 MiB; errores/protocolos desconocidos bloquean
sin registrar secretos ni el cuerpo remoto. Cada mapping fija una huella del
endpoint para evitar cruzar destinos por un cambio de configuración. Mover la
cuenta a otro origen exige revisar los vínculos, no reasignarlos automáticamente.

El código no arranca crons ni crea tareas programadas. Después de revisar y
desplegar el cambio y configurar la conexión autorizada, un asistente puede
recorrer la revisión diariamente y ante avisos nuevos del inbox. Sólo asocia
casos inequívocos; presenta los demás al usuario. Una política de suspensiones,
tolerancias, reembolsos o conciliación de deuda requiere definición e
implementación separada antes de habilitar cualquier cambio automático de acceso.

Fuentes: `programPaymentSourceService.js`, `programPaymentAssociationService.js`,
`magnetismoPaymentVerificationClient.js` y `mcp/programPaymentTools.js` del backend.
Contrato remoto de consulta contrastado con Magnetismo `83180c3`; las pruebas
usan SQLite aislado y respuestas MCP simuladas, sin tocar alumnos ni pagos reales.

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
