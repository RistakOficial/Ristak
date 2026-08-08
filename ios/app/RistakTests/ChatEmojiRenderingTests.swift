import XCTest
@testable import Ristak

final class ChatEmojiRenderingTests: XCTestCase {
    func testReactionWithoutLoadedTargetDisplaysEmojiInsteadOfGenericMessage() throws {
        let events = try decodeEvents(
            """
            [
              {
                "type": "whatsapp_message",
                "date": "2026-07-14T12:00:00Z",
                "data": {
                  "whatsapp_api_message_id": "reaction-1",
                  "provider_message_id": "wamid.reaction-1",
                  "message_type": "reaction",
                  "message_text": "",
                  "reaction_emoji": "😂",
                  "reaction_target_provider_message_id": "wamid.outside-window",
                  "direction": "inbound",
                  "transport": "api"
                }
              }
            ]
            """
        )

        let message = try XCTUnwrap(
            ChatJourneyParser.buildMessages(contactId: "contact-1", events: events).first
        )

        XCTAssertEqual(message.text, "😂")
        XCTAssertEqual(message.reactionEmoji, "😂")
        XCTAssertEqual(MessagePreviewText.preview(for: message), "😂")
    }

    func testReactionRecoversEmojiFromProviderTextWhenDedicatedFieldIsMissing() throws {
        let events = try decodeEvents(
            """
            [
              {
                "type": "whatsapp_message",
                "date": "2026-07-14T12:01:00Z",
                "data": {
                  "whatsapp_api_message_id": "reaction-2",
                  "message_type": "reaction",
                  "message_text": "🔥",
                  "reaction_target_provider_message_id": "wamid.outside-window",
                  "direction": "outbound",
                  "transport": "qr"
                }
              }
            ]
            """
        )

        let message = try XCTUnwrap(
            ChatJourneyParser.buildMessages(contactId: "contact-1", events: events).first
        )

        XCTAssertEqual(message.text, "🔥")
        XCTAssertEqual(message.reactionEmoji, "🔥")
    }

    func testCachedReactionWithLegacyGenericTextStillDisplaysEmoji() {
        let message = ChatMessage(
            id: "cached-reaction",
            contactId: "contact-1",
            date: "2026-07-14T12:01:30Z",
            direction: .inbound,
            text: "Mensaje",
            channel: "whatsapp",
            messageType: "reaction",
            reactionEmoji: "👍"
        )

        XCTAssertEqual(message.displayText, "👍")
        XCTAssertEqual(MessagePreviewText.preview(for: message), "👍")
        XCTAssertEqual(ChatInboxActivity(message: message).text, "👍")
    }

    func testStickerUsesImageAttachmentAndStickerPreview() throws {
        let events = try decodeEvents(
            """
            [
              {
                "type": "whatsapp_message",
                "date": "2026-07-14T12:02:00Z",
                "data": {
                  "whatsapp_api_message_id": "sticker-1",
                  "message_type": "sticker",
                  "message_text": "",
                  "media_url": "https://cdn.example.com/media/sticker-1",
                  "direction": "inbound",
                  "transport": "api"
                }
              }
            ]
            """
        )

        let message = try XCTUnwrap(
            ChatJourneyParser.buildMessages(contactId: "contact-1", events: events).first
        )

        XCTAssertEqual(message.attachment?.type, .image)
        XCTAssertEqual(message.text, "")
        XCTAssertEqual(MessagePreviewText.preview(for: message), "Sticker")
    }

    func testWhatsAppTemplateKeepsVisibleStructureWithoutActionPayloads() throws {
        let events = try decodeEvents(
            """
            [
              {
                "type": "whatsapp_message",
                "date": "2026-08-04T04:00:00Z",
                "data": {
                  "whatsapp_api_message_id": "template-1",
                  "message_type": "template",
                  "message_text": "Aquí está el enlace.\\n\\n- Google Meet",
                  "direction": "outbound",
                  "transport": "api",
                  "message_presentation": {
                    "kind": "template",
                    "header": { "kind": "text", "text": "Tu cita está por comenzar" },
                    "body": "Aquí está el enlace.",
                    "footer": "Puedes ir ingresando.",
                    "buttons": [
                      {
                        "type": "url",
                        "label": "Google Meet",
                        "url": "https://example.test/tracked",
                        "payload": "private-action"
                      }
                    ]
                  }
                }
              }
            ]
            """
        )

        let message = try XCTUnwrap(
            ChatJourneyParser.buildMessages(contactId: "contact-1", events: events).first
        )
        let presentation = try XCTUnwrap(message.presentation)
        XCTAssertEqual(presentation.kind, .template)
        XCTAssertEqual(presentation.header?.text, "Tu cita está por comenzar")
        XCTAssertEqual(presentation.body, "Aquí está el enlace.")
        XCTAssertEqual(presentation.footer, "Puedes ir ingresando.")
        XCTAssertEqual(presentation.buttons, [
            WhatsAppMessagePresentation.Action(type: .url, label: "Google Meet")
        ])
    }

    func testWhatsAppContactKeepsStructuredRowsWithoutUnsafeFields() throws {
        let events = try decodeEvents(
            """
            [
              {
                "type": "whatsapp_message",
                "date": "2026-08-07T18:00:00Z",
                "data": {
                  "whatsapp_api_message_id": "contact-card-1",
                  "message_type": "contacts",
                  "direction": "inbound",
                  "transport": "api",
                  "message_presentation": {
                    "kind": "contacts",
                    "header": { "kind": "text", "text": "Contacto compartido" },
                    "body": "",
                    "buttons": [],
                    "sections": [{
                      "title": "Carlos Mendoza",
                      "items": [
                        { "kind": "phone", "label": "+52 443 147 5304", "href": "tel:+524431475304" },
                        { "kind": "email", "label": "carlos@example.com" }
                      ]
                    }]
                  }
                }
              }
            ]
            """
        )

        let message = try XCTUnwrap(ChatJourneyParser.buildMessages(contactId: "contact-1", events: events).first)
        let presentation = try XCTUnwrap(message.presentation)
        XCTAssertEqual(presentation.kind, .contacts)
        XCTAssertEqual(presentation.sections.first?.title, "Carlos Mendoza")
        XCTAssertEqual(presentation.sections.first?.items, [
            WhatsAppMessagePresentation.Section.Item(kind: .phone, label: "+52 443 147 5304"),
            WhatsAppMessagePresentation.Section.Item(kind: .email, label: "carlos@example.com")
        ])
    }

    private func decodeEvents(_ json: String) throws -> [JourneyEvent] {
        try JSONDecoder().decode([JourneyEvent].self, from: Data(json.utf8))
    }
}
