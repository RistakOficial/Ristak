# 📅 Módulo de Calendarios y Citas

> **Sección aislada**: Este módulo puede eliminarse completo sin afectar el resto de la aplicación.

## 📁 Ubicación de Archivos

```
📦 FRONTEND
├── src/pages/Appointments/
│   ├── Appointments.tsx          # Componente principal
│   ├── Appointments.module.css   # Estilos
│   ├── index.ts                  # Exportación
│   └── README.md                 # Este archivo
│
├── src/services/
│   └── calendarsService.ts       # Servicio API de calendarios
│
├── src/utils/format.ts           # Función formatTime12h() agregada
│
├── src/App.tsx                   # Ruta /appointments agregada
│
└── src/components/layout/Sidebar/
    └── Sidebar.tsx               # Ítem de menú "Citas" agregado

📦 BACKEND
├── src/controllers/
│   └── calendarsController.js    # Controlador de calendarios
│
├── src/routes/
│   └── calendars.routes.js       # Rutas API
│
├── src/services/
│   └── highlevelCalendarService.js  # Servicio para API de HighLevel
│
└── src/server.js                 # Import y uso de calendars.routes.js
```

## 🎯 Funcionalidad

### Vista Principal
- **Navegación entre calendarios**: Permite cambiar entre múltiples calendarios de HighLevel
- **Vista mensual**: Calendario completo con eventos agrupados por día
- **KPIs de citas**:
  - Pendientes
  - Canceladas
  - Confirmadas
  - Reprogramadas
- **Próximas citas**: Lista ordenada de las siguientes 8 citas
- **Colores por estado**: Cada estado de cita tiene un color distintivo

### Integraciones
- **API de Calendarios de HighLevel**: Integración completa usando OAuth 2.0
- **Endpoints utilizados**:
  - `GET https://services.leadconnectorhq.com/calendars/` - Listar calendarios
  - `GET https://services.leadconnectorhq.com/calendars/:id` - Detalles de calendario
  - `GET https://services.leadconnectorhq.com/calendars/events` - Eventos/citas
  - `GET https://services.leadconnectorhq.com/calendars/:id/free-slots` - Slots disponibles

## 🔌 Endpoints Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/calendars` | Obtener todos los calendarios |
| GET | `/api/calendars/:id` | Obtener calendario específico |
| GET | `/api/calendars/events` | Obtener eventos/citas de un rango |
| GET | `/api/calendars/:id/free-slots` | Obtener slots disponibles |
| POST | `/api/calendars/appointments` | Crear nueva cita |
| PUT | `/api/calendars/appointments/:id` | Actualizar cita |
| DELETE | `/api/calendars/events/:id` | Eliminar evento |

## 📊 Estados de Citas

| Estado | Color | Descripción |
|--------|-------|-------------|
| `confirmed` | Verde | Cita confirmada |
| `pending` | Amarillo | Pendiente de confirmación |
| `cancelled` | Rojo | Cita cancelada |
| `showed` | Azul | Contacto asistió |
| `noshow` | Gris | Contacto no asistió |
| `rescheduled` | Morado | Cita reprogramada |

## ⚙️ Configuración Requerida

Para que este módulo funcione, se requiere:

1. **HighLevel configurado** en Settings → Integraciones
2. **Location ID** válido
3. **Access Token** con permisos de calendarios
4. **Scopes necesarios**:
   - `calendars.readonly` - Ver calendarios y eventos
   - `calendars.write` - Crear/editar citas (opcional)

## 🚀 Cómo Usar

### Frontend
```typescript
import { Appointments } from '@/pages/Appointments';

// Acceder vía ruta
navigate('/appointments');
```

### Backend
```javascript
import calendarsService from './services/highlevelCalendarService.js';

// Obtener calendarios
const calendars = await calendarsService.getCalendars(locationId, accessToken);

// Obtener eventos
const events = await calendarsService.getCalendarEvents(
  locationId,
  startTime,
  endTime,
  accessToken
);
```

## 🗑️ Cómo Eliminar Este Módulo

Si decides remover esta funcionalidad:

### 1. Eliminar archivos Frontend
```bash
# Página
rm -rf frontend/src/pages/Appointments/

# Servicio
rm frontend/src/services/calendarsService.ts
```

### 2. Eliminar archivos Backend
```bash
# Controlador
rm backend/src/controllers/calendarsController.js

# Rutas
rm backend/src/routes/calendars.routes.js

# Servicio
rm backend/src/services/highlevelCalendarService.js
```

### 3. Limpiar imports y rutas

**frontend/src/App.tsx**
```typescript
// ELIMINAR:
import { Appointments } from '@/pages/Appointments'
// ...
<Route path="appointments" element={<Appointments />} />
```

**frontend/src/components/layout/Sidebar/Sidebar.tsx**
```typescript
// ELIMINAR del array navigation:
{ name: 'Citas', href: '/appointments', icon: Calendar }

// ELIMINAR del import:
Calendar
```

**backend/src/server.js**
```javascript
// ELIMINAR:
import calendarsRoutes from './routes/calendars.routes.js'
// ...
app.use('/api/calendars', calendarsRoutes)
```

**frontend/src/utils/format.ts**
```typescript
// OPCIONAL: Eliminar función formatTime12h() si no se usa en otro lugar
```

### 4. Actualizar CLAUDE.md
- Remover referencias a Appointments/ en estructura de carpetas
- Remover calendarsService.ts de la lista de servicios
- Remover endpoints /api/calendars/* de la lista de API
- Remover la sección de funcionalidad de Citas

## 🎨 Diseño

El diseño sigue los patrones establecidos en el resto de la app:
- **CSS Modules** para estilos aislados
- **Variables CSS** del design system
- **Componentes comunes** reutilizados (KpiCard, Card, Button, PageContainer)
- **Responsive** adaptado a diferentes pantallas

## 📝 Notas Técnicas

- **AuthContext** se usa para obtener locationId y accessToken
- **NotificationContext** para mostrar errores y mensajes
- Las fechas se manejan como timestamps en milisegundos para los rangos
- La vista semanal/día está en desarrollo (placeholder implementado)
- Los colores de eventos usan variables CSS del theme

## 🔮 Próximas Mejoras (Pendientes)

- [ ] Vista de semana funcional
- [ ] Vista de día funcional
- [ ] Modal para crear citas desde la interfaz
- [ ] Edición de citas existentes
- [ ] Visualización de horarios disponibles
- [ ] Configuración avanzada de calendarios
- [ ] Sincronización automática de eventos
- [ ] Webhooks para eventos de calendario
