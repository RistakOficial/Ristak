# 📅 Servicio de Calendarios de HighLevel

> **Módulo aislado**: Toda la lógica de calendarios está contenida en archivos específicos que pueden eliminarse sin afectar otras funcionalidades.

## 📁 Archivos del Módulo

```
backend/src/
├── services/
│   ├── highlevelCalendarService.js   # Servicio principal (ESTE ARCHIVO)
│   └── README_CALENDARS.md           # Documentación
│
├── controllers/
│   └── calendarsController.js        # Controlador de endpoints
│
├── routes/
│   └── calendars.routes.js           # Definición de rutas
│
└── server.js                         # Import de routes (líneas 24 y 58)
```

## 🔌 API de HighLevel

Este servicio se conecta a la API oficial de HighLevel:

**Base URL**: `https://services.leadconnectorhq.com`
**Versión API**: `2021-04-15`
**Autenticación**: Bearer Token (OAuth 2.0)

### Documentación Oficial
- [HighLevel API - Calendars](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars)
- [HighLevel API - Calendar Events](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendar-events)

## 📊 Funciones Disponibles

### `getCalendars(locationId, accessToken)`
Obtiene todos los calendarios de una ubicación.

**Parámetros:**
- `locationId` (string): ID de la ubicación en HighLevel
- `accessToken` (string): Token de autenticación OAuth

**Retorna:** `Promise<Calendar[]>`

**Ejemplo:**
```javascript
const calendars = await getCalendars('loc_xxxxx', 'token_xxxxx');
```

---

### `getCalendar(calendarId, accessToken)`
Obtiene detalles de un calendario específico.

**Parámetros:**
- `calendarId` (string): ID del calendario
- `accessToken` (string): Token de autenticación OAuth

**Retorna:** `Promise<Calendar>`

---

### `getCalendarEvents(locationId, startTime, endTime, accessToken, calendarId?)`
Obtiene eventos/citas de un rango de fechas.

**Parámetros:**
- `locationId` (string): ID de la ubicación
- `startTime` (number): Timestamp inicio en milisegundos
- `endTime` (number): Timestamp fin en milisegundos
- `accessToken` (string): Token de autenticación OAuth
- `calendarId` (string, opcional): Filtrar por calendario específico

**Retorna:** `Promise<CalendarEvent[]>`

**Ejemplo:**
```javascript
const now = Date.now();
const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getTime();

const events = await getCalendarEvents(
  'loc_xxxxx',
  now,
  endOfMonth,
  'token_xxxxx',
  'cal_xxxxx'
);
```

---

### `getFreeSlots(calendarId, startDate, endDate, accessToken, timezone?)`
Obtiene slots disponibles de un calendario.

**Parámetros:**
- `calendarId` (string): ID del calendario
- `startDate` (string): Fecha inicio (YYYY-MM-DD)
- `endDate` (string): Fecha fin (YYYY-MM-DD)
- `accessToken` (string): Token de autenticación OAuth
- `timezone` (string, opcional): Zona horaria (default: "America/Mexico_City")

**Retorna:** `Promise<FreeSlot[]>`

---

### `createAppointment(appointmentData, accessToken)`
Crea una nueva cita en el calendario.

**Parámetros:**
- `appointmentData` (object): Datos de la cita
- `accessToken` (string): Token de autenticación OAuth

**Retorna:** `Promise<CalendarEvent>`

**Ejemplo:**
```javascript
const newAppointment = await createAppointment({
  calendarId: 'cal_xxxxx',
  locationId: 'loc_xxxxx',
  contactId: 'contact_xxxxx',
  startTime: '2025-10-20T10:00:00-06:00',
  endTime: '2025-10-20T11:00:00-06:00',
  title: 'Consulta inicial',
  appointmentStatus: 'confirmed'
}, 'token_xxxxx');
```

---

### `updateAppointment(eventId, updateData, accessToken)`
Actualiza una cita existente.

**Parámetros:**
- `eventId` (string): ID del evento/cita
- `updateData` (object): Datos a actualizar
- `accessToken` (string): Token de autenticación OAuth

**Retorna:** `Promise<CalendarEvent>`

---

### `deleteEvent(eventId, accessToken)`
Elimina un evento del calendario.

**Parámetros:**
- `eventId` (string): ID del evento
- `accessToken` (string): Token de autenticación OAuth

**Retorna:** `Promise<boolean>`

## 🔒 Seguridad

- **Tokens nunca se guardan**: Los tokens se pasan como parámetros en cada llamada
- **Logging de errores**: Todos los errores se registran con el logger personalizado
- **Validación de respuestas**: Se valida el status code antes de procesar datos

## 📝 Estructura de Datos

### Calendar
```javascript
{
  id: "cal_xxxxx",
  locationId: "loc_xxxxx",
  name: "Consultas Generales",
  description: "Calendario para consultas generales",
  isActive: true,
  eventColor: "#039be5",
  slotDuration: 60,
  slotDurationUnit: "mins",
  slotInterval: 30,
  slotIntervalUnit: "mins",
  appoinmentPerSlot: 1,
  appoinmentPerDay: 8,
  openHours: [
    {
      daysOfTheWeek: [1, 2, 3, 4, 5], // Lun-Vie
      hours: [
        {
          openHour: 9,
          openMinute: 0,
          closeHour: 18,
          closeMinute: 0
        }
      ]
    }
  ]
}
```

### CalendarEvent
```javascript
{
  id: "evt_xxxxx",
  title: "Cita con Juan Pérez",
  calendarId: "cal_xxxxx",
  locationId: "loc_xxxxx",
  contactId: "contact_xxxxx",
  appointmentStatus: "confirmed", // confirmed|pending|cancelled|showed|noshow|rescheduled
  startTime: "2025-10-20T10:00:00-06:00",
  endTime: "2025-10-20T11:00:00-06:00",
  dateAdded: "2025-10-15T14:30:00Z",
  assignedUserId: "user_xxxxx",
  notes: "Primera consulta",
  address: "https://meet.google.com/xxx-xxxx-xxx"
}
```

## 🚨 Manejo de Errores

Todos los errores se capturan y se registran con el logger:

```javascript
try {
  const calendars = await getCalendars(locationId, accessToken);
} catch (error) {
  // Error ya registrado en el logger
  // Retorna array vacío o lanza el error según la función
}
```

Los errores comunes incluyen:
- **401 Unauthorized**: Token inválido o expirado
- **403 Forbidden**: Permisos insuficientes (scopes faltantes)
- **404 Not Found**: Calendario o evento no existe
- **429 Too Many Requests**: Rate limit excedido

## 🗑️ Cómo Eliminar Este Módulo

1. **Eliminar archivos**:
```bash
rm backend/src/services/highlevelCalendarService.js
rm backend/src/services/README_CALENDARS.md
rm backend/src/controllers/calendarsController.js
rm backend/src/routes/calendars.routes.js
```

2. **Limpiar server.js**:
```javascript
// ELIMINAR línea 24:
import calendarsRoutes from './routes/calendars.routes.js'

// ELIMINAR línea 58:
app.use('/api/calendars', calendarsRoutes)
```

3. **Limpiar CLAUDE.md**:
   - Remover referencias en estructura de carpetas
   - Remover endpoints /api/calendars/*
   - Remover de sección de integraciones

## 📚 Referencias

- [HighLevel API Documentation](https://marketplace.gohighlevel.com/docs)
- [OAuth 2.0 HighLevel](https://highlevel.stoplight.io/docs/integrations/00d0c0ecaa369-overview)
- [Calendars API Reference](https://marketplace.gohighlevel.com/docs/ghl/calendars/calendars)

## 🔄 Versionamiento

- **v1.0.0** (2025-10-17): Implementación inicial
  - Funciones GET para calendarios y eventos
  - Funciones POST/PUT/DELETE para gestión de citas
  - Integración con logger personalizado
  - Documentación completa
