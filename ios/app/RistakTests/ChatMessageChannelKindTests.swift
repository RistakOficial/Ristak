import XCTest
@testable import Ristak

final class ChatMessageChannelKindTests: XCTestCase {
    func testWhatsAppAPIAndQRAreDifferentVisualChannels() {
        XCTAssertEqual(
            ChatMessageChannelKind.resolve(eventType: "whatsapp_message", transport: "api"),
            .whatsappAPI
        )
        XCTAssertEqual(
            ChatMessageChannelKind.resolve(eventType: "whatsapp_message", transport: "qr"),
            .whatsappQR
        )
        XCTAssertEqual(
            ChatMessageChannelKind.resolve(channel: "whatsapp", transport: "baileys"),
            .whatsappQR
        )
        XCTAssertEqual(ChatMessageChannelKind.resolve(channel: "whatsapp_qr"), .whatsappQR)
        XCTAssertEqual(ChatMessageChannelKind.resolve(channel: "whatsapp", provider: "qr"), .whatsappQR)
    }

    func testMetaPlatformsWinOverGenericAPITransport() {
        XCTAssertEqual(
            ChatMessageChannelKind.resolve(eventType: "meta_message", transport: "api", platform: "instagram"),
            .instagram
        )
        XCTAssertEqual(
            ChatMessageChannelKind.resolve(channel: "facebook_comment", transport: "meta"),
            .messenger
        )
    }

    func testEmailAndSMSStayNeutralChannels() {
        XCTAssertEqual(ChatMessageChannelKind.resolve(eventType: "email_message", transport: "smtp"), .email)
        XCTAssertEqual(ChatMessageChannelKind.resolve(channel: "sms_qr", transport: "qr"), .sms)
        XCTAssertEqual(ChatMessageChannelKind.resolve(eventType: "sms_message"), .sms)
    }
}
