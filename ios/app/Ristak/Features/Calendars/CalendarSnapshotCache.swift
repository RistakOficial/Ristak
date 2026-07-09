import Foundation

/// Codec de snapshot en disco para Calendarios (Round 6 #4, stale-while-revalidate).
///
/// `RistakCalendar` y `CalendarAppointment` son modelos de Core **solo
/// Decodable** (tienen `init(from:)` tolerante pero NO `encode(to:)` simétrico),
/// así que no se pueden guardar con `RistakSnapshotCache.store(_:)`. En su lugar
/// —igual que `ChatInboxDiskCache`— serializamos un subconjunto de campos con
/// los MISMOS nombres de clave del contrato JSON del backend y lo guardamos como
/// `Data` crudo (`storeRaw`). Al leer, `RistakSnapshotCache.value([Modelo].self,
/// for:)` lo re-decodifica con el `init(from:)` tolerante del modelo, obteniendo
/// exactamente el mismo objeto que un fetch en vivo (round-trip garantizado).
enum CalendarSnapshotCodec {
    /// Tope de citas guardadas por mes para no inflar el disco.
    static let maxEvents = 600

    // MARK: - Calendarios

    /// `Data` JSON (array) del subconjunto de campos de `RistakCalendar` que la
    /// UI necesita para pintar (nombre, color, slots, tipo, estado). Las claves
    /// coinciden con `RistakCalendar.CodingKeys`.
    static func encode(calendars: [RistakCalendar]) -> Data? {
        let rows: [[String: Any]] = calendars.map { calendar in
            var entry: [String: Any] = [
                "id": calendar.id,
                "googleCalendarId": calendar.googleCalendarId,
                "googleSyncEnabled": calendar.googleSyncEnabled,
                "locationId": calendar.locationId,
                "name": calendar.name,
                "description": calendar.description,
                "slug": calendar.slug,
                "widgetSlug": calendar.widgetSlug,
                "calendarType": calendar.calendarType,
                "eventTitle": calendar.eventTitle,
                "eventColor": calendar.eventColor,
                "isActive": calendar.isActive,
                "slotDuration": calendar.slotDuration,
                "slotDurationUnit": calendar.slotDurationUnit,
                "slotInterval": calendar.slotInterval,
                "slotIntervalUnit": calendar.slotIntervalUnit,
                "appoinmentPerSlot": calendar.appoinmentPerSlot,
                "appoinmentPerDay": calendar.appoinmentPerDay,
                "autoConfirm": calendar.autoConfirm,
                "allowReschedule": calendar.allowReschedule,
                "allowCancellation": calendar.allowCancellation,
                "notes": calendar.notes,
                "source": calendar.source,
            ]
            if let ghlID = calendar.ghlCalendarId { entry["ghlCalendarId"] = ghlID }
            if let groupID = calendar.groupId { entry["groupId"] = groupID }
            if let publicURL = calendar.publicUrl { entry["publicUrl"] = publicURL }
            if let publicEnabled = calendar.publicUrlEnabled { entry["publicUrlEnabled"] = publicEnabled }
            return entry
        }
        guard JSONSerialization.isValidJSONObject(rows) else { return nil }
        return try? JSONSerialization.data(withJSONObject: rows)
    }

    // MARK: - Citas

    /// `Data` JSON (array, capado a `maxEvents`) del subconjunto de campos de
    /// `CalendarAppointment`. Las claves coinciden con
    /// `CalendarAppointment.CodingKeys` (`appointmentStatus` es el crudo).
    static func encode(appointments: [CalendarAppointment]) -> Data? {
        let rows: [[String: Any]] = appointments.prefix(maxEvents).map { event in
            var entry: [String: Any] = [
                "id": event.id,
                "calendarId": event.calendarId,
                "locationId": event.locationId,
                "title": event.title,
                "status": event.status,
                "appointmentStatus": event.appointmentStatusRaw,
                "notes": event.notes,
                "address": event.address,
                "startTime": event.startTime,
                "endTime": event.endTime,
                "source": event.source,
                "contactName": event.contactName,
                "contactEmail": event.contactEmail,
                "contactPhone": event.contactPhone,
            ]
            if let ghlID = event.ghlAppointmentId { entry["ghlAppointmentId"] = ghlID }
            if let googleID = event.googleEventId { entry["googleEventId"] = googleID }
            if let contactID = event.contactId { entry["contactId"] = contactID }
            if let assigned = event.assignedUserId { entry["assignedUserId"] = assigned }
            if let added = event.dateAdded { entry["dateAdded"] = added }
            if let updated = event.dateUpdated { entry["dateUpdated"] = updated }
            return entry
        }
        guard JSONSerialization.isValidJSONObject(rows) else { return nil }
        return try? JSONSerialization.data(withJSONObject: rows)
    }
}
