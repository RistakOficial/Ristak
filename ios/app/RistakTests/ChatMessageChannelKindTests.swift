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

    func testChatBubblesUseLightPaletteInDayMode() {
        assertColor(RistakTheme.bubbleInbound, equals: (255, 255, 255), style: .light)
        assertColor(RistakTheme.bubbleOutbound, equals: (240, 241, 244), style: .light)
        assertColor(RistakTheme.chatChannelWhatsAppAPI, equals: (217, 253, 211), style: .light)
        assertColor(RistakTheme.chatChannelWhatsAppQR, equals: (198, 239, 189), style: .light)
    }

    func testChatBubblesUseDeepPaletteInNightMode() {
        assertColor(RistakTheme.bubbleInbound, equals: (36, 37, 39), style: .dark)
        assertColor(RistakTheme.bubbleOutbound, equals: (48, 49, 53), style: .dark)
        assertColor(RistakTheme.chatChannelWhatsAppAPI, equals: (11, 73, 57), style: .dark)
        assertColor(RistakTheme.chatChannelWhatsAppQR, equals: (18, 79, 59), style: .dark)
        assertColor(RistakTheme.chatChannelInstagram, equals: (74, 38, 61), style: .dark)
        assertColor(RistakTheme.chatChannelMessenger, equals: (27, 60, 102), style: .dark)
        assertColor(RistakTheme.bubbleTextInbound, equals: (245, 245, 247), style: .dark)
        assertColor(RistakTheme.bubbleMeta, equals: (183, 183, 189), style: .dark)
    }

    func testVisualMediaCanvasIsStableBeforeTheFileLoads() {
        XCTAssertEqual(ChatVisualMediaLayout.size, CGSize(width: 252, height: 189))
    }

    func testVisualMediaKindIsKnownBeforeAttachmentHydrates() {
        XCTAssertEqual(
            ChatVisualMediaPresentation.kind(attachment: nil, messageType: "image"),
            .image
        )
        XCTAssertEqual(
            ChatVisualMediaPresentation.kind(attachment: nil, messageType: "video"),
            .video
        )
        XCTAssertNil(
            ChatVisualMediaPresentation.kind(attachment: nil, messageType: "text")
        )
        XCTAssertNil(
            ChatVisualMediaPresentation.kind(
                attachment: ChatAttachment(type: .audio),
                messageType: "video"
            )
        )
    }

    func testVisualMediaPlaceholderUsesTheFinalAttachmentKind() {
        let image = ChatVisualMediaPresentation.attachment(actual: nil, messageType: "photo")
        let video = ChatVisualMediaPresentation.attachment(actual: nil, messageType: "video_message")

        XCTAssertEqual(image?.type, .image)
        XCTAssertEqual(image?.name, "Foto")
        XCTAssertEqual(video?.type, .video)
        XCTAssertEqual(video?.name, "Video")
    }

    func testGeneratedMediaFallbackDoesNotBecomeASecondFooter() {
        XCTAssertEqual(ChatVisualMediaPresentation.caption("Foto", kind: .image), "")
        XCTAssertEqual(ChatVisualMediaPresentation.caption("Vídeo", kind: .video), "")
        XCTAssertEqual(
            ChatVisualMediaPresentation.caption("Mira esto", kind: .image),
            "Mira esto"
        )
    }
}
