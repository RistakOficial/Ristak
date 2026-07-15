import Foundation

/// Estado de conexión de una integración dentro de
/// `GET /api/integrations/status` (respuesta SIN envelope — doc 08 §5.2).
struct IntegrationConnectionState: Decodable, Sendable, Equatable {
    let configured: Bool
    let connected: Bool
    let connectionType: String?
    let mode: String?
    let publishableKey: String?
    let accountLabel: String?
    let locationId: String?
    let hasApiKey: Bool?
    let webhookConfigured: Bool?

    enum CodingKeys: String, CodingKey {
        case configured, connected, connectionType, mode, publishableKey
        case accountLabel, locationId, hasApiKey, webhookConfigured
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        configured = container.flexibleBool(forKey: .configured) ?? false
        connected = container.flexibleBool(forKey: .connected) ?? false
        connectionType = container.flexibleString(forKey: .connectionType)
        mode = container.flexibleString(forKey: .mode)
        publishableKey = container.flexibleString(forKey: .publishableKey)
        accountLabel = container.flexibleString(forKey: .accountLabel)
        locationId = container.flexibleString(forKey: .locationId)
        hasApiKey = container.flexibleBool(forKey: .hasApiKey)
        webhookConfigured = container.flexibleBool(forKey: .webhookConfigured)
    }

    /// «Conectado» para la UI: `connected === true` (RN también acepta
    /// `configured === true`).
    var isUsable: Bool { connected || configured }
}

/// `GET /api/integrations/status` — objeto RAÍZ pelado (sin `success/data`).
struct IntegrationsStatus: Decodable, Sendable, Equatable {
    let highlevel: IntegrationConnectionState?
    let meta: IntegrationConnectionState?
    let whatsapp: IntegrationConnectionState?
    let openai: IntegrationConnectionState?
    let googleCalendar: IntegrationConnectionState?
    let stripe: IntegrationConnectionState?
    let mercadopago: IntegrationConnectionState?
    let conekta: IntegrationConnectionState?
    let clip: IntegrationConnectionState?
    let rebill: IntegrationConnectionState?

    enum CodingKeys: String, CodingKey {
        case highlevel, meta, whatsapp, openai, googleCalendar
        case stripe, mercadopago, conekta, clip, rebill
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        highlevel = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .highlevel)
        meta = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .meta)
        whatsapp = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .whatsapp)
        openai = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .openai)
        googleCalendar = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .googleCalendar)
        stripe = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .stripe)
        mercadopago = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .mercadopago)
        conekta = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .conekta)
        clip = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .clip)
        rebill = try? container.decodeIfPresent(IntegrationConnectionState.self, forKey: .rebill)
    }

    func state(for gateway: PaymentGateway) -> IntegrationConnectionState? {
        switch gateway {
        case .stripe: return stripe
        case .conekta: return conekta
        case .mercadopago: return mercadopago
        case .clip: return clip
        case .rebill: return rebill
        }
    }

    /// Pasarelas de pago conectadas (`connected || configured`).
    var connectedGateways: [PaymentGateway] {
        PaymentGateway.allCases.filter { state(for: $0)?.isUsable == true }
    }

    var isHighLevelConnected: Bool { highlevel?.connected == true }
}

struct HighLevelPhoneNumber: Decodable, Sendable, Equatable, Identifiable {
    let id: String
    let phoneNumber: String
    let label: String
    let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id, phoneNumber, label, isDefault
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = container.flexibleString(forKey: .id) ?? ""
        phoneNumber = container.flexibleString(forKey: .phoneNumber) ?? ""
        label = container.flexibleString(forKey: .label) ?? ""
        isDefault = container.flexibleBool(forKey: .isDefault) ?? false
    }
}

struct HighLevelPhoneNumberCatalog: Decodable, Sendable, Equatable {
    let success: Bool
    let phoneNumbers: [HighLevelPhoneNumber]
    let selectable: Bool
    let fallbackToAccountDefault: Bool
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case success, phoneNumbers, selectable, fallbackToAccountDefault, reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        success = container.flexibleBool(forKey: .success) ?? false
        phoneNumbers = (try? container.decodeIfPresent([HighLevelPhoneNumber].self, forKey: .phoneNumbers)) ?? []
        selectable = container.flexibleBool(forKey: .selectable) ?? false
        fallbackToAccountDefault = container.flexibleBool(forKey: .fallbackToAccountDefault) ?? true
        reason = container.flexibleString(forKey: .reason)
    }
}
