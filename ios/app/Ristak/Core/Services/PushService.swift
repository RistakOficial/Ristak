import Foundation

/// Endpoints de registro push (doc research/11 §5). `/mobile-devices` solo
/// requiere sesión (sin gate de módulo); `/public-key` es público.
enum PushService {
    /// `GET /api/push/public-key` → config pública. Validar
    /// `iosConfigured == true` ANTES de pedir permiso/registrar.
    static func publicConfig() async throws -> PushPublicKeyConfig {
        try await APIClient.shared.get("/api/push/public-key")
    }

    /// `POST /api/push/mobile-devices` — registra/reactiva el device token
    /// APNs (HEX). Upsert por token; re-registrar reactiva y actualiza
    /// metadata. Errores 400: «Falta la llave de notificaciones del celular»,
    /// «Este tipo de celular no está soportado para notificaciones».
    static func registerDevice(_ registration: MobilePushDeviceRegistration) async throws -> MobilePushDeviceAck {
        try await APIClient.shared.post("/api/push/mobile-devices", body: registration)
    }

    /// `DELETE /api/push/mobile-devices` `{ token }` — marca `enabled=0`.
    /// 403 `FORBIDDEN` («No puedes apagar este celular») si el token es de
    /// otro usuario. Llamarlo best-effort en logout.
    static func unregisterDevice(token: String) async throws {
        try await APIClient.shared.delete(
            "/api/push/mobile-devices",
            body: MobilePushDeviceDeleteRequest(token: token)
        )
    }
}
