import XCTest
import SwiftUI
import UIKit
@testable import Ristak

final class ChatMessageChannelKindTests: XCTestCase {
    private func assertColor(
        _ color: Color,
        equals expected: (red: Int, green: Int, blue: Int),
        style: UIUserInterfaceStyle = .light,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha), file: file, line: line)
        XCTAssertEqual(Int((red * 255).rounded()), expected.red, file: file, line: line)
        XCTAssertEqual(Int((green * 255).rounded()), expected.green, file: file, line: line)
        XCTAssertEqual(Int((blue * 255).rounded()), expected.blue, file: file, line: line)
    }

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

    func testIncomingIsWhiteAndWhatsAppOutgoingGreensStayLight() {
        assertColor(RistakTheme.bubbleInbound, equals: (255, 255, 255), style: .light)
        assertColor(RistakTheme.bubbleInbound, equals: (255, 255, 255), style: .dark)
        assertColor(RistakTheme.chatChannelWhatsAppAPI, equals: (217, 253, 211))
        assertColor(RistakTheme.chatChannelWhatsAppQR, equals: (198, 239, 189))
    }
}
