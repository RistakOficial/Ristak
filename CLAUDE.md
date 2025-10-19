- # 🧠 CONTEXTO MAESTRO - RISTAK APP
> **IMPORTANTE**: Este archivo es la fuente de verdad del proyecto. La IA DEBE leerlo SIEMPRE antes de cualquier tarea y actualizarlo cuando haga cambios estructurales.

## 📋 REGLAS CRÍTICAS DE DESARROLLO

### ⚠️ MANDAMIENTOS INQUEBRANTABLES
1. **NUNCA crear archivos nuevos si ya existe uno similar** - SIEMPRE modificar el existente
2. **NUNCA dejar código muerto o componentes huérfanos** - Si no se usa, se elimina
3. **NUNCA duplicar funcionalidad** - Una sola fuente de verdad para cada cosa
4. **NUNCA hacer cambios sin verificar el contexto completo** - Leer TODO el proyecto antes
5. **SIEMPRE actualizar este archivo** cuando cambies la estructura o agregues features
6. **SIEMPRE limpiar imports no usados** y dependencias fantasma
7. **NUNCA commitear console.logs** de debug en producción
8. **🔴 ENTORNO DE TRABAJO: TODO ES RENDER (PRODUCCIÓN)**
   - SIEMPRE commit + push después de cada cambio
   - Los cambios se ven en Render directamente
   - PostgreSQL es la ÚNICA base de datos
   - Render auto-deploya en cada push a main
9. **❌ NUNCA usar alertas nativas del browser** - SIEMPRE usar modales personalizados
   - ❌ Prohibido: `alert()`, `confirm()`, `prompt()`, `window.alert()`, `window.confirm()`, `window.prompt()`
   - ✅ Usar: `showConfirm()`, `showAlert()`, `showInfo()` del NotificationContext
   - ✅ Para modales personalizados: Modal component con `createPortal` de React
   - ✅ Diseño minimalista: sin barras de colores, sin fondos en iconos, gris neutro
   - 🎯 Objetivo: UX consistente, elegante y profesional en toda la app
10. **🚫 NUNCA implementar OAuth centralizado para integraciones de terceros**
   - ❌ PROHIBIDO: OAuth flows donde la app de Ristak actúa como intermediario
   - ❌ Razón: Cada usuario tiene su propia app de Facebook/Meta/Google con credenciales únicas
   - ❌ No se puede usar un App ID/Secret centralizado para todos los usuarios
   - ✅ En su lugar: Configuración manual con tokens de acceso propios de cada usuario
   - ✅ Documentación clara de cómo obtener sus propias credenciales
   - 🎯 Aplica a: Meta Ads, Google Ads, TikTok Ads, cualquier plataforma de anuncios

### �� FILOSOFÍA DE CÓDIGO
- **Limpio > Rápido**: Preferir código mantenible sobre optimizaciones prematuras
- **Explícito > Implícito**: Nombres descriptivos, nada de magia negra
- **Consistente > Creativo**: Seguir los patrones ya establecidos
- **Actualizar > Parchear**: Si algo está roto, arreglarlo bien, no poner curitas

---

## 🏗️ ARQUITECTURA ACTUAL

### Stack Tecnológico
```
Frontend:
├── React 19.0.0 + TypeScript 5.7.2
├── Vite 6.0.11 (bundler)
├── React Router DOM 7.1.3
├── Recharts 2.15.0 (gráficas)
├── Lucide React (iconos)
└── Lodash 4.17.21 (utilidades)

Backend:
├── Node.js 20+ con ES Modules
├── Express 4.21.2
├── PostgreSQL (pg 8.11.3)
├── Node-cron 3.0.3 (tareas programadas)
└── CORS 2.8.5
```

### Estructura de Carpetas
```
/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── common/        # Componentes reutilizables
│   │   │   │   ├── Button/
│   │   │   │   ├── Card/
│   │   │   │   ├── ContactDetailsModal/
│   │   │   │   ├── ContactSearchInput/
│   │   │   │   ├── DateRangePicker/
│   │   │   │   ├── Icon/
│   │   │   │   ├── KpiCard/
│   │   │   │   ├── LineChart/
│   │   │   │   ├── Modal/
│   │   │   │   ├── TabList/
│   │   │   │   ├── Table/
│   │   │   │   ├── Toast/
│   │   │   │   ├── ViewSelector/
│   │   │   │   ├── SyncProgressBar/
│   │   │   │   ├── RecordPaymentModal/  # Modal de registro de pagos offline
│   │   │   │   └── index.ts   # Exportaciones centralizadas
│   │   │   └── layout/
│   │   │       └── AppShell/  # Layout principal
│   │   ├── contexts/          # Estado global
│   │   │   ├── AuthContext.tsx
│   │   │   ├── DateRangeContext.tsx
│   │   │   ├── NotificationContext.tsx
│   │   │   ├── ThemeContext.tsx
│   │   │   └── TimezoneContext.tsx
│   │   ├── pages/             # Páginas/Vistas
│   │   │   ├── Dashboard/
│   │   │   ├── Campaigns/
│   │   │   ├── Contacts/
│   │   │   ├── Reports/
│   │   │   ├── Settings/
│   │   │   │   ├── Settings.tsx
│   │   │   │   ├── HighLevelIntegration.tsx
│   │   │   │   ├── MetaAdsIntegration.tsx
│   │   │   │   ├── PaymentsConfiguration.tsx
│   │   │   │   └── WebTracking.tsx    # Página de configuración del pixel de tracking
│   │   │   ├── Transactions/
│   │   │   ├── Appointments/  # Gestión de calendarios y citas de HighLevel
│   │   │   └── Analytics/     # Página de analíticas (solo visible si tracking configurado)
│   │   ├── services/          # Llamadas API
│   │   │   ├── apiClient.ts
│   │   │   ├── campaignsService.ts
│   │   │   ├── contactsService.ts
│   │   │   ├── dashboardService.ts
│   │   │   ├── highLevelService.ts
│   │   │   ├── reportsService.ts
│   │   │   ├── transactionsService.ts
│   │   │   ├── calendarsService.ts   # Servicio para Calendarios de HighLevel
│   │   │   ├── trackingService.ts    # Servicio para Pixel de Tracking
│   │   │   └── analyticsService.ts   # Servicio para Analíticas
│   │   ├── styles/            # Estilos globales
│   │   │   ├── index.css
│   │   │   ├── theme.css
│   │   │   └── tokens.css
│   │   ├── types/             # TypeScript types
│   │   │   ├── index.ts
│   │   │   ├── facebook.d.ts
│   │   │   └── metrics.ts
│   │   ├── utils/             # Utilidades
│   │   │   ├── format.ts
│   │   │   ├── tableStorage.ts
│   │   │   └── timezone.ts
│   │   ├── App.tsx            # Componente raíz
│   │   └── main.tsx           # Entry point
│   └── dist/                  # Build de producción
│
├── backend/
│   └── src/
│       ├── config/
│       │   ├── constants.js
│       │   └── database.js    # Conexión DB PostgreSQL
│       ├── controllers/
│       │   ├── dashboardController.js
│       │   ├── highlevelController.js
│       │   ├── metaController.js
│       │   ├── reportsController.js
│       │   ├── webhooksController.js
│       │   ├── calendarsController.js  # Controlador para Calendarios de HighLevel
│       │   └── trackingController.js   # Controlador para Pixel de Tracking
│       ├── jobs/
│       │   ├── metaSync.cron.js           # Cron: Sincroniza Meta Ads cada hora
│       │   └── contactsSync.cron.js       # Cron: Sincroniza contactos de GHL cada hora (silencioso)
│       ├── routes/
│       │   ├── dashboard.routes.js
│       │   ├── highlevel.routes.js
│       │   ├── meta.routes.js
│       │   ├── reports.routes.js
│       │   ├── webhooks.routes.js
│       │   ├── calendars.routes.js    # Rutas para Calendarios API
│       │   └── tracking.routes.js     # Rutas para Pixel de Tracking
│       ├── services/
│       │   ├── highlevelSyncService.js
│       │   ├── metaAdsService.js
│       │   ├── highlevelCalendarService.js  # Servicio para API de Calendarios GHL
│       │   └── trackingService.js     # Servicio para gestión de sesiones de tracking
│       ├── utils/
│       │   ├── dateUtils.js
│       │   └── logger.js      # Sistema de logging personalizado
│       └── server.js          # Entry point del backend
```

---

## 🔌 INTEGRACIONES ACTIVAS

### HighLevel
- **Estado**: Implementación parcial (contactos, pipelines, calendarios)
- **Endpoints**: `/api/highlevel/*`, `/api/calendars/*`
- **Servicios**: `highlevelSyncService.js`, `highLevelService.ts`, `highlevelCalendarService.js`, `calendarsService.ts`
- **Funcionalidad**:
  - Sincronización de contactos y pipelines
  - Gestión de calendarios y citas
  - Visualización de horarios disponibles
  - Estadísticas de citas (pendientes, confirmadas, canceladas, reprogramadas)

### Meta Ads (Facebook)
- **Estado**: Parcialmente implementado
- **Endpoints**: `/api/meta/*`
- **Servicios**: `metaAdsService.js`, `campaignsService.ts`
- **Cron Job**: Sincronización cada hora via `metaSync.cron.js`
- **Funcionalidad**: Métricas de campañas publicitarias

### Cron Jobs (Tareas Programadas)
- **Estado**: Implementado y activo
- **Archivos**: `backend/src/jobs/*.cron.js`
- **Cron Jobs Activos**:
  - `metaSync.cron.js`: Sincroniza anuncios de Meta cada hora (a las XX:00)
  - `contactsSync.cron.js`: Sincroniza contactos, citas y pagos de HighLevel cada hora (a las XX:00)
    - **Característica importante**: Este cron usa `triggerSource: 'cron'` para NO mostrar la barra lateral de progreso
    - Solo las sincronizaciones manuales (desde Settings) muestran la barra lateral (`triggerSource: 'manual'`)
    - Mantiene la base de datos actualizada automáticamente en caso de que se borren contactos externamente
- **Configuración**: Se inician automáticamente al arrancar el servidor (`server.js`)

### Webhooks
- **Estado**: Configurado
- **Endpoint**: `/webhook/*`
- **Controlador**: `webhooksController.js`
- **Funcionalidad**: Recepción de eventos externos

### Pixel de Tracking
- **Estado**: Implementado completamente
- **Endpoints**: `/snip.js`, `/collect`, `/api/tracking/sessions`
- **Servicios**: `trackingService.js`
- **Funcionalidad**:
  - Pixel JavaScript dinámico que captura visitas
  - Same-Origin usando CNAME del cliente (ej. ristak.sudominio.com)
  - Captura UTMs, click IDs (gclid, fbclid, msclkid, ttclid, wbraid, gbraid)
  - Cookies de Facebook (fbc, fbp)
  - Información de dispositivo, navegador, idioma, timezone
  - Gestión automática de sesiones (visitor_id + session_id)
  - API para consultar sesiones capturadas
- **Documentación**: Ver `TRACKING_PIXEL.md`

---

## 📊 MODELO DE DATOS

### Tablas Principales
```sql
-- Estructura actual en uso
contacts: id, email, phone, name, tags, created_at, updated_at
campaigns: id, name, platform, status, metrics, created_at
transactions: id, contact_id, amount, type, date, metadata
reports: id, type, data, generated_at
sessions: session_id, visitor_id, contact_id, utm_*, gclid, fbclid, etc (ver TRACKING_PIXEL.md)
```

### API Endpoints
```
GET    /api/health                      # Health check
GET    /api/dashboard/stats             # KPIs principales
GET    /api/dashboard/chart             # Datos para gráficas
GET    /api/contacts                    # Lista de contactos
GET    /api/campaigns                   # Campañas activas
GET    /api/transactions                # Transacciones
GET    /api/reports                     # Reportes generados

# Calendarios (HighLevel)
GET    /api/calendars                   # Obtener todos los calendarios
GET    /api/calendars/:id               # Obtener calendario específico
GET    /api/calendars/events            # Obtener eventos/citas de un rango
GET    /api/calendars/:id/free-slots    # Obtener slots disponibles
POST   /api/calendars/appointments      # Crear nueva cita (acepta contactId y assignedUserId opcionales)
PUT    /api/calendars/appointments/:id  # Actualizar cita
DELETE /api/calendars/events/:id        # Eliminar evento

# Contactos y Usuarios (HighLevel)
POST   /api/highlevel/contacts/search   # Buscar contactos en tiempo real
GET    /api/highlevel/contacts/:id      # Obtener contacto por ID
GET    /api/highlevel/users             # Obtener usuarios del location

# Pixel de Tracking (Auto-configuración)
GET    /snip.js                         # Pixel JavaScript (dinámico por dominio)
POST   /collect                         # Recibir eventos del pixel
GET    /api/tracking/sessions           # Obtener sesiones capturadas
GET    /api/tracking/sessions/:id       # Obtener sesión específica
GET    /api/tracking/config             # Detectar dominio automáticamente
POST   /api/tracking/configure          # Guardar snippet en HighLevel

# Webhooks
POST   /webhook/highlevel               # Webhook de HighLevel
POST   /webhook/meta                    # Webhook de Meta
```

---

## 🎨 PATRONES DE DISEÑO

### Frontend
- **CSS Modules** para estilos componentes (`.module.css`)
- **Context API** para estado global (no Redux)
- **Services Layer** para todas las llamadas API
- **Custom Hooks** cuando se reutiliza lógica
- **Barrel exports** en carpetas de componentes (`index.ts`)
- **Componente Table con re-cómputo reactivo** (`Table.tsx:89`):
  - Las columnas se recomputan automáticamente cuando cambian las dependencias (ej: dateRange, viewType)
  - Los render callbacks de cada columna se sincronizan con el estado actual sin recargar la página
  - Evita callbacks obsoletos (stale closures) que causaban que los modales mostraran datos de rangos anteriores
  - useEffect observa: `[columns, savedLayout]` → recomputa `processedColumns` → sincroniza con `internalColumns`
  - ⚠️ **Crítico**: Sin este patrón, la tabla cache los primeros callbacks y los modales consultan fechas viejas

### Backend
- **MVC Pattern** (Model-View-Controller)
- **Service Layer** para lógica de negocio
- **Route Handlers** delgados (solo validación y respuesta)
- **Utils** para funciones helper reutilizables
- **Logger personalizado** en vez de console.log

---

## 🔧 CONFIGURACIÓN DE ENTORNO

### Variables Requeridas en Render
```bash
# Backend en Render:
NODE_ENV=production
DATABASE_URL=<postgres-connection-string>  # Auto-generado por Render
HIGHLEVEL_CLIENT_ID=<tu-client-id>
HIGHLEVEL_CLIENT_SECRET=<tu-client-secret>
TRACKING_DOMAIN=<tu-dominio-personalizado>  # Opcional, ej: ristak.tudominio.com

# Frontend en Render:
VITE_API_URL=<url-backend-render>  # ej: https://ristak-api.onrender.com
```

---

## 📝 SISTEMA DE NOTIFICACIONES Y MODALES ESTANDARIZADO

### 🎯 Regla de Oro
**NUNCA usar alertas/confirmaciones nativas del browser. SIEMPRE usar NotificationContext.**

### ✅ Cómo Usar Notificaciones y Modales

#### 1. Importar el hook
```typescript
import { useNotification } from '@/contexts/NotificationContext'

const { showToast, showConfirm, showAlert, showInfo } = useNotification()
```

#### 2. Mostrar Toasts (notificaciones temporales)
```typescript
// Éxito
showToast('success', 'Operación exitosa', 'El registro se guardó correctamente')

// Error
showToast('error', 'Error al guardar', 'No se pudo completar la operación')

// Advertencia
showToast('warning', 'Atención', 'Algunos campos no están completos')

// Información
showToast('info', 'Información', 'Esta acción puede tardar unos minutos')
```

#### 3. Mostrar Modales de Confirmación
```typescript
// Confirmación (con botones Cancelar y Aceptar)
showConfirm(
  'Eliminar pago',
  '¿Estás seguro de eliminar este pago? Esta acción no se puede deshacer.',
  async () => {
    // Acción al confirmar
    await deletePayment(id)
    showToast('success', 'Pago eliminado')
  },
  'Eliminar',  // Texto del botón confirmar (opcional)
  'Cancelar'   // Texto del botón cancelar (opcional)
)

// Alerta (solo botón Aceptar)
showAlert(
  'Error crítico',
  'No se pudo conectar con el servidor. Intenta nuevamente.',
  'Entendido'  // Texto del botón (opcional)
)

// Información (solo botón Aceptar, diseño neutral)
showInfo(
  'Actualización disponible',
  'Hay una nueva versión de la aplicación disponible.',
  'Aceptar'  // Texto del botón (opcional)
)
```

#### 4. Modales Personalizados
Para modales con contenido custom (formularios, etc):
```typescript
import { Modal } from '@/components/common'
import { createPortal } from 'react-dom'

const [isOpen, setIsOpen] = useState(false)

return createPortal(
  <Modal
    isOpen={isOpen}
    onClose={() => setIsOpen(false)}
    title="Título del Modal"
    size="md"  // sm | md | lg | xl
    type="custom"
  >
    {/* Contenido custom aquí */}
  </Modal>,
  document.body
)
```

### 🎨 Diseño de Modales Estandarizado
- ✅ Sin barras de colores superiores
- ✅ Iconos grises simples (24x24px)
- ✅ Sin fondos de colores en iconos
- ✅ Diseño minimalista y elegante
- ✅ Consistente en toda la app

---

## 📝 ESTADO DE COMPONENTES

### ✅ Componentes Activos y Funcionales
- AppShell, Button, Card, Modal, TabList
- KpiCard, LineChart, Table, SyncProgressBar
- DateRangePicker, DateTimePicker, ContactDetailsModal, ContactSearchInput
- ViewSelector, Icon, Toast, ToastContainer, RecordPaymentModal, AppointmentModal

### ❌ Componentes Eliminados (NO RECREAR)
- Badge, Select, Input, DatePicker
- SingleDatePicker, DateRangeInput
- SyncProgressBanner

---

## 🚀 CÓMO DEPLOYAR CAMBIOS

### Flujo de Trabajo en Render
1. **Hacer cambios** en el código (en GitHub o con git)
2. **Commit + Push** a la rama `main`:
   ```bash
   git add .
   git commit -m "feat: descripción del cambio"
   git push origin main
   ```
3. **Render auto-deploya** en ~3-5 minutos
4. **Verificar** en la URL de producción

### Comandos Git Útiles
```bash
# Ver estado de cambios
git status

# Hacer commit de todos los cambios
git add .
git commit -m "descripción del cambio"

# Subir a Render (trigger deploy automático)
git push origin main

# Ver logs del último commit
git log -1
```

---

## 🐛 PROBLEMAS CONOCIDOS

### Actuales
- Bundle size warning (>500KB) - Considerar code splitting
- Falta implementación completa de HighLevel API

### Funcionalidades Implementadas
- ✓ **Página de Contactos (Contacts.tsx)**:
  - Edición de contactos desde la tabla (modal con campos editables: nombre, email, teléfono, fuente, nombre del anuncio, ID del anuncio)
  - Eliminación de contactos con modal de confirmación
  - **Modal de detalles de contacto** con secciones:
    - Información Personal (nombre, email, teléfono, estado)
    - Historial de Compras (total de compras, pagos totales, última compra)
    - **Citas** (primera cita histórica, próxima cita agendada)
    - De dónde llegó el contacto (fuente, anuncio, ID del anuncio)
  - Backend calcula fechas de citas desde tabla `appointments`:
    - `firstAppointmentDate`: la cita más antigua del contacto
    - `nextAppointmentDate`: la cita más cercana en el futuro que no esté cancelada
    - **🎯 ATRIBUCIÓN**: Para métricas de campañas, las citas se cuentan basándose en la **fecha de creación del contacto**, NO en la fecha de la cita. Esto es crítico para medir correctamente la atribución de marketing:
      - Si un contacto se creó el 1 de enero y agenda su primera cita el 15 de febrero, la cita se atribuye a las campañas del 1 de enero
      - Esto permite medir el verdadero impacto de las campañas publicitarias en la generación de citas
      - Un contacto con múltiples citas cuenta como 1 solo contacto con cita (métrica binaria: tiene o no tiene cita)
      - La lógica está implementada en `metaController.js` y `analyticsService.js`
  - Datos de citas: Se obtienen primero de la DB local (tabla `appointments`), y si no existen, se hace fallback a HighLevel API en tiempo real
  - Endpoints backend: PUT /api/contacts/:id, DELETE /api/contacts/:id, GET /api/contacts/:id
  - Protección contra eliminación accidental con confirmación explícita
- ✓ Registro de pagos offline (RecordPaymentModal):
  - Búsqueda de contactos en tiempo real
  - 2 tipos de cobro: directo (solo monto) o desde productos guardados
  - Permite personalizar monto del producto seleccionado
  - Crea invoice en HighLevel y lo marca como pagado automáticamente
  - 3 opciones de pago: Enviar enlace, Cobrar tarjeta guardada (solo si Stripe está conectado), Registrar pago manual
  - Detección automática de Stripe: Si no está configurado, solo muestra opciones de enlace y pago manual
  - Alerta visual cuando Stripe no está disponible con instrucciones para configurarlo
  - Endpoints: GET /api/highlevel/products, GET /api/highlevel/products/:id/prices, POST /api/highlevel/invoices, POST /api/highlevel/invoices/:id/record-payment, GET /api/highlevel/stripe-config
  - Integrado en página de Transactions con botón "+ Registrar pago"
  - ⚠️ Nota: Cargar productos requiere scope `products.readonly` en el token de HighLevel. El cobro directo funciona sin este scope.

- ✓ Gestión de Calendarios y Citas (página Appointments):
  - Visualización de calendarios de HighLevel con navegación entre calendarios
  - Vista mensual de calendario con eventos agrupados por día
  - KPIs de citas: pendientes, canceladas, confirmadas, reprogramadas
  - Lista de próximas citas ordenadas cronológicamente
  - Código de colores según estado de cita (confirmada, pendiente, cancelada, etc.)
  - **Creación/edición de citas con modal en 2 columnas**:
    - Modal con layout responsivo: columna izquierda (asignación), columna derecha (configuración)
    - Búsqueda en tiempo real de contactos por nombre, email o teléfono (OBLIGATORIO)
    - Auto-fill del título con el nombre del contacto seleccionado
    - **Soporte para calendarios Round Robin**:
      - Detección automática de calendarios Round Robin (calendarType o eventType)
      - Filtrado de usuarios: solo muestra team members del calendario Round Robin
      - Selector de team member obligatorio para Round Robin
      - Texto de ayuda explicando la funcionalidad
    - Validaciones: contacto siempre requerido, team member requerido para Round Robin
    - Modal de confirmación para eliminación (nunca usa alert() del browser)
    - Backend endpoints: GET /api/highlevel/contacts/:id, GET /api/highlevel/users
  - Integración completa con API de Calendarios de HighLevel
  - Backend endpoints: GET /api/calendars, GET /api/calendars/:id, GET /api/calendars/events, GET /api/calendars/:id/free-slots, POST /api/calendars/appointments, PUT /api/calendars/appointments/:id, DELETE /api/calendars/events/:id
  - Servicios: highlevelCalendarService.js (backend), calendarsService.ts (frontend), ghlClient.js (método getLocationUsers)
  - Ruta: /appointments
  - ⚠️ Nota: Requiere locationId y accessToken de HighLevel configurados
  - ⚠️ Vista semana/día en desarrollo (placeholder implementado)

- ✓ **Pixel de Tracking implementado (2025-10-17)**:
  - Sistema completo de tracking con pixel JavaScript dinámico
  - Same-Origin usando CNAME (ej. ristak.cliente.com)
  - Captura UTMs, click IDs (gclid, fbclid, msclkid, ttclid, wbraid, gbraid)
  - Cookies de Facebook (fbc, fbp), device info, referrer, IP
  - Tabla `sessions` con 50+ campos de atribución
  - **Auto-configuración de 1 clic**: GET /api/tracking/config, POST /api/tracking/configure
  - Detección automática de dominio personalizado (prioridad: TRACKING_DOMAIN env var > req.headers.host > RENDER_EXTERNAL_URL)
  - Guarda snippet automáticamente en HighLevel custom value `rstktrack`
  - Usuario solo agrega `{{ custom_values.rstktrack }}` en <head> de su sitio
  - Endpoints: GET /snip.js, POST /collect, GET /api/tracking/sessions
  - Backend: trackingController.js, trackingService.js, tracking.routes.js
  - Frontend: WebTracking.tsx (en Settings), trackingService.ts
  - Página de configuración con snippet generator y stats en tiempo real
  - Ruta: /settings/tracking
  - Documentación completa en TRACKING_PIXEL.md y PIXEL_SETUP.md
  - Sin hardcodear dominios (detección dinámica por req.headers.host)
  - Base de datos: PostgreSQL

- ✓ **Página de Analíticas implementada (2025-10-18)**:
  - Página completa de analíticas basada en datos de la tabla `sessions`
  - **Visibilidad condicional**: Solo aparece en el menú si el tracking está configurado en HighLevel
  - 8 KPIs principales con tendencias vs período anterior:
    - Visualizaciones de página, Visitantes únicos, Registros, Conversión
    - Tasa de rebote, Duración promedio, Usuarios recurrentes, Páginas/sesión
  - Gráfico de área dual: Visitas totales + Visitantes únicos por fecha
  - Comparación automática con período anterior (mismo número de días hacia atrás)
  - Cálculo de registros reales: contactos que aparecen tanto en `contacts` como en `sessions`
  - Backend endpoints: GET /api/tracking/sessions?start=YYYY-MM-DD&end=YYYY-MM-DD
  - Usa endpoint existente GET /api/tracking/config para detectar si tracking está activo
  - Backend: trackingController.js (modificado), trackingService.js (getSessionsByDateRange agregado)
  - Frontend: Analytics.tsx, analyticsService.ts
  - Sidebar.tsx: Llama a checkTrackingStatus() y agrega "Analíticas" al menú solo si isConfigured === true
  - Ruta: /analytics (solo accesible si tracking configurado)
  - Diseño adaptado al estilo de la app (mismo patrón que Dashboard y otras páginas)
  - Duración promedio estimada (events_count * 45 segundos) - No es tiempo real

- ✓ **Sistema Híbrido de Configuración (2025-10-18)** [IMPLEMENTADO]:
  - Sistema centralizado para TODA la configuración de la app (preferencias, columnas de tablas, etc)
  - **Arquitectura híbrida**:
    - **LocalStorage**: Cache de lectura rápida (0ms, funciona offline)
    - **PostgreSQL**: Fuente de verdad (persistencia confiable, sync entre dispositivos)
    - **Sincronización automática**: Al cargar la página, valida con DB y actualiza cache si difiere
  - **Endpoints backend**:
    - GET /api/config: Lee toda la configuración o keys específicas (?keys=key1,key2)
    - POST /api/config: Guarda una o múltiples configs (body: {key, value} o {config: {...}})
    - DELETE /api/config: Elimina configs (?keys=key1,key2)
  - **Hooks frontend**:
    - `useAppConfig(key, defaultValue)`: Config individual con cache + DB sync
    - `useAppConfigs([keys])`: Múltiples configs a la vez
    - `useTableConfig(tableId)`: Específico para configuración de tablas (columnas, orden, visibilidad)
  - **Migración completada**:
    - ✅ visitor_source preference (plataforma vs tracking interno)
    - ✅ show_analytics preference (mostrar/ocultar Analytics en menú)
    - ✅ Configuración de columnas de todas las tablas (orden, visibilidad, anchos)
  - **Ventajas**:
    - Lectura instantánea desde cache (no espera a DB)
    - Persiste aunque borres cookies/localStorage (respaldo en DB)
    - Consistente entre dispositivos (sincroniza desde DB)
    - Resiliente: funciona offline con cache
    - Centralizado: un solo sistema para toda la app
  - **Archivos**:
    - Backend: configController.js, config.routes.js
    - Frontend: hooks/useAppConfig.ts, hooks/index.ts
    - Modificados: WebTracking.tsx, Campaigns.tsx, Reports.tsx, Table.tsx
  - **Deprecado**: utils/tableStorage.ts (reemplazado por useTableConfig hook)

- ✓ **Toggle de Fuente de Visitantes (2025-10-18)** [USA SISTEMA HÍBRIDO]:
  - Opción en Settings/Web Tracking para elegir fuente de visitantes: "Plataforma de Anuncios" vs "Tracking Interno"
  - Afecta páginas de Campaigns y Reports mostrando visitantes de Meta/Google o del tracking interno
  - **Ahora usa sistema híbrido de configuración** (useAppConfig hook)
  - **Páginas afectadas**:
    - **Campaigns**: Actualiza visitantes en ads cuando está en modo "Tracking Interno"
    - **Reports**: Actualiza columna de visitantes cuando está en modo "Tracking Interno"
  - **Backend endpoints**:
    - GET /api/tracking/visitors-by-ad: Obtiene visitantes únicos por ad_id desde sessions
    - GET /api/tracking/visitors-by-period: Obtiene visitantes agrupados por período (día/semana/mes/año)
  - **Persistencia**: Sistema híbrido (cache + PostgreSQL app_config)
  - **Detección de visitor**: Webhook /contacts SOLO acepta campo 'rkvi_id' (prohibido visitor_id o rstk_vid)
  - **Matching visitor-contacto**: 4 métodos (form submit, _ud cookie, link manual, rkvi_id en _ud)

### Resueltos
- ✓ Lodash instalado como dependencia directa
- ✓ 7 componentes huérfanos eliminados (Badge, Select, Input, DatePicker, SingleDatePicker, DateRangeInput, SyncProgressBanner)
- ✓ Imports no usados limpiados
- ✓ Puerto sincronizado a 3001 en todo el proyecto (antes era inconsistente 3001 vs 3002)
- ✓ Health check endpoint implementado (/api/health)
- ✓ useEffect con dependencias incorrectas arreglado en Campaigns.tsx
- ✓ URL hardcodeada eliminada en Campaigns.tsx (ahora usa campaignsService)
- ✓ console.logs de producción eliminados (frontend y backend)
- ✓ Backend usa logger consistentemente en lugar de console.log
- ✓ formatChartDate movido a utils/format.ts para reutilización
- ✓ Archivos .env.example consolidados (solo uno en raíz con documentación completa)
- ✓ Mapeo correcto de fechas de GHL: created_at guarda dateAdded (no fecha de sincronización)
- ✓ Tabla contacts actualizada con campo updated_at
- ✓ Sincronización actualiza estadísticas de contactos automáticamente (total_paid, purchases_count, last_purchase_date)
- ✓ Webhooks recalculan estadísticas en tiempo real al recibir pagos/reembolsos
- ✓ appointment_date se actualiza correctamente al sincronizar/recibir citas
- ✓ Tooltips en gráficos corregidos (LineChart y AreaChart):
  - Reemplazado SmartRechartsTooltip roto (heredado de otra app)
  - Implementación simplificada que funciona correctamente con Recharts
  - Props simplificadas (solo content, cursor, wrapperStyle)
  - Tooltips ahora visibles al hacer hover sobre los gráficos
  - CSS mejorado para .recharts-tooltip-wrapper y .recharts-default-tooltip
  - Build exitoso sin errores de compilación
- ✓ Tracking pixel: prioridad de detección de dominio corregida (2025-10-17):
  - Bug: Detectaba ristak-app.onrender.com en vez de ristak.midominio.com
  - Fix: Cambió prioridad a TRACKING_DOMAIN env var > req.headers.host > RENDER_EXTERNAL_URL
  - Ahora captura correctamente custom domains cuando el usuario accede vía CNAME
  - Aplicado en getTrackingConfig y configureTracking
  - Probado con curl -H "Host: ristak.midominio.com" → funciona correctamente
- ✓ **Chips y badges invisibles en dark mode (2025-10-18)**:
  - Bug crítico: Los estilos usaban `[data-theme="dark"]` pero el sistema usa `body.dark` y `body.light`
  - Primer intento fallido: Cambió selectores a `body.dark` pero CSS Modules hashea las clases (`.success` → `._success_mfnum_26`)
  - **Fix definitivo**: Usar `:global(body.dark)` en CSS Modules para escapar el scope del hash
  - Archivos afectados: Badge.module.css, Appointments.module.css
  - Aumentada opacidad de fondos (0.2→0.3 en badges, 0.25→0.35 en appointments) para mejor contraste
  - Texto blanco (#ffffff) con font-weight 600/700 en todos los chips en dark mode
  - Afecta: Badges (success, warning, error, info, purple, default), Chips de citas (Confirmed, Pending, Cancelled, Showed, Noshow, Rescheduled), chip "Hoy", chip de hora en próximas citas
  - El sistema de temas está en ThemeContext.tsx que aplica clases `body.dark` y `body.light` (líneas 98-99)
  - Solución: `:global(body.dark) .localClass` permite que CSS Modules encuentre la clase global body.dark
  - Ahora todos los chips y badges son completamente legibles en dark mode
- ✓ **Modal de confirmación para eliminar citas (2025-10-18)**:
  - Bug: Usaba `window.confirm()` en vez de modal personalizado (violaba reglas del proyecto)
  - Fix: Implementado modal de confirmación usando `createPortal` de React (patrón de Contacts.tsx)
  - Estado `showDeleteConfirm` para controlar visibilidad del modal
  - Modal con overlay, título, mensaje descriptivo y botones Cancelar/Eliminar
  - Estilos: deleteModalOverlay, deleteModal, deleteModalHeader, deleteModalActions en AppointmentModal.module.css
  - Botón eliminar ahora muestra "Eliminando..." durante la operación
  - Archivo modificado: AppointmentModal.tsx, AppointmentModal.module.css
  - Nueva regla añadida a MANDAMIENTOS INQUEBRANTABLES: Nunca usar alert(), confirm() o prompt()
- ✓ **Modal de creación de citas rediseñado con 2 columnas (2025-10-18)**:
  - Layout con grid responsivo: columna izquierda 300px (asignación), columna derecha flexible (configuración)
  - Columna izquierda: búsqueda de contacto + selector de usuario/team member
  - Columna derecha: título, estado, fechas, ubicación, notas
  - Auto-fill del título con nombre del contacto seleccionado
  - Contacto ahora es OBLIGATORIO para crear citas (antes era opcional)
  - Validación con toast notifications en vez de alert()
  - Responsive: columnas se apilan verticalmente en pantallas <900px
  - Max-width del modal aumentado de 640px a 900px
- ✓ **Soporte para calendarios Round Robin (2025-10-18)**:
  - **Flujo correcto según API de HighLevel**:
    1. GET /calendars/:id → obtiene teamMembers[] con userId
    2. POST /api/highlevel/users/by-ids → obtiene datos completos de usuarios
  - Detección automática: calendarType === 'round_robin' o eventType.includes('RoundRobin')
  - Backend: métodos getUserById(), getUsersByIds() en ghlClient.js
  - Nuevo endpoint: POST /api/highlevel/users/by-ids (recibe array de userIds)
  - Frontend: loadUsers() hace POST con teamMemberIds extraídos de calendar.teamMembers
  - **Fallback inteligente**: Si falta scope `users.readonly`, muestra "Usuario {id}..." en selector
  - UI condicional: "Team member *" (obligatorio) para RR vs "Usuario asignado (opcional)" para normales
  - Validación obligatoria de assignedUserId para calendarios Round Robin
  - ⚠️ **Limitación actual**: Token sin scope `users.readonly` → solo muestra IDs truncados
  - ✅ **Funcionalidad**: Asignación funciona perfectamente aunque falte el nombre pretty
  - Archivos: ghlClient.js, highlevelController.js, highlevel.routes.js, AppointmentModal.tsx
  - Script de prueba: test-round-robin.js para debugging

---

## 📅 ÚLTIMA ACTUALIZACIÓN

**Fecha**: 2025-10-18
**Versión**: 1.14.0
**Último cambio estructural**:
- **Sistema Híbrido de Configuración (cache + DB)**
  - Implementado sistema centralizado para toda la configuración de la app
  - LocalStorage como cache (lectura instantánea) + PostgreSQL como fuente de verdad
  - Hooks: useAppConfig(), useAppConfigs(), useTableConfig()
  - Endpoints: GET/POST/DELETE /api/config
  - Migradas todas las preferencias al nuevo sistema
  - Ventajas: rápido, persistente, sincronizado entre dispositivos, resiliente
  - Deprecado: utils/tableStorage.ts (usar useTableConfig hook)
  - Archivos: configController.js, config.routes.js, hooks/useAppConfig.ts

---

## ⚡ CHECKLIST ANTES DE MODIFICAR

Antes de hacer CUALQUIER cambio, la IA debe:

- [ ] Leer este archivo completo
- [ ] Verificar si ya existe código similar
- [ ] Buscar componentes/funciones relacionadas
- [ ] Validar que no rompe nada existente
- [ ] Actualizar este archivo si cambia la estructura
- [ ] Eliminar código muerto que genere
- [ ] Verificar imports y dependencias
- [ ] Hacer build para confirmar que compila
- [ ] Hacer commit y push para deployar en Render

---

## 🔴 RECORDATORIO FINAL

**NUNCA OLVIDES**: Este proyecto debe mantenerse LIMPIO, ORDENADO y SIN REDUNDANCIAS. Cada línea de código debe tener un propósito. Si no lo tiene, no debe existir.

**ACTUALIZA ESTE ARCHIVO** cuando:
- Agregues/elimines componentes
- Cambies la estructura de carpetas
- Implementes nuevas integraciones
- Modifiques el modelo de datos
- Encuentres/resuelvas problemas

NO agregues historial de cambios. ACTUALIZA la información existente para reflejar el estado ACTUAL.
