import Foundation
import XCTest
@testable import Ristak

final class ChatInboxActivityReducerTests: XCTestCase {
    func testOutboundActivityPromotesRowEvenWhenDeviceTimestampIsOlder() throws {
        let first = try contact(id: "first", date: "2026-07-10T12:00:00Z", unread: 0)
        let second = try contact(id: "second", date: "2026-07-10T11:00:00Z", unread: 3)
        let activity = ChatInboxActivity(message: message(
            id: "outbound-1",
            contactID: "second",
            date: "2026-07-10T10:00:00Z",
            direction: .outbound,
            text: "Respuesta"
        ))

        let reduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: [first, second],
            isDuplicate: false
        ))

        XCTAssertTrue(reduction.promoted)
        XCTAssertEqual(reduction.rows.map(\.id), ["second", "first"])
        XCTAssertEqual(reduction.rows[0].lastMessageText, "Respuesta")
        XCTAssertEqual(reduction.rows[0].lastMessageDirection, "outbound")
        XCTAssertEqual(reduction.rows[0].unreadCount, 0)
    }

    func testInboundActivityPromotesAndIncrementsUnreadOnlyOnce() throws {
        let first = try contact(id: "first", date: "2026-07-10T12:00:00Z", unread: 0)
        let second = try contact(id: "second", date: "2026-07-10T11:00:00Z", unread: 4)
        let activity = ChatInboxActivity(
            message: message(
                id: "inbound-1",
                contactID: "second",
                date: "2026-07-10T13:00:00Z",
                direction: .inbound,
                text: "Hola"
            ),
            conversationIsVisible: false
        )

        let firstReduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: [first, second],
            isDuplicate: false
        ))
        XCTAssertEqual(firstReduction.rows.map(\.id), ["second", "first"])
        XCTAssertEqual(firstReduction.rows[0].unreadCount, 5)

        let duplicateReduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: firstReduction.rows,
            isDuplicate: true
        ))
        XCTAssertEqual(duplicateReduction.rows[0].unreadCount, 5)
    }

    func testStaleInboundActivityCannotOverwriteOrPromoteNewerRow() throws {
        let first = try contact(id: "first", date: "2026-07-10T12:00:00Z", unread: 0)
        let second = try contact(id: "second", date: "2026-07-10T13:00:00Z", unread: 1)
        let activity = ChatInboxActivity(
            message: message(
                id: "stale",
                contactID: "second",
                date: "2026-07-10T11:00:00Z",
                direction: .inbound,
                text: "Viejo"
            ),
            conversationIsVisible: false
        )

        let reduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: [first, second],
            isDuplicate: false
        ))

        XCTAssertFalse(reduction.promoted)
        XCTAssertEqual(reduction.rows.map(\.id), ["first", "second"])
        XCTAssertEqual(reduction.rows[1].lastMessageDate, "2026-07-10T13:00:00Z")
        XCTAssertEqual(reduction.rows[1].lastMessageText, "Mensaje second")
        XCTAssertEqual(reduction.rows[1].unreadCount, 2)
    }

    private func contact(id: String, date: String, unread: Int) throws -> ChatContact {
        let json = """
        {
          "id": "\(id)",
          "name": "Contacto \(id)",
          "phone": "+520000000000",
          "lastMessageText": "Mensaje \(id)",
          "lastMessageType": "text",
          "lastMessageChannel": "whatsapp",
          "lastMessageTransport": "api",
          "lastMessageDirection": "inbound",
          "lastMessageDate": "\(date)",
          "unreadCount": \(unread)
        }
        """
        return try JSONDecoder().decode(ChatContact.self, from: Data(json.utf8))
    }

    private func message(
        id: String,
        contactID: String,
        date: String,
        direction: ChatMessageDirection,
        text: String
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            contactId: contactID,
            date: date,
            direction: direction,
            text: text,
            channel: "whatsapp",
            transport: "api",
            messageType: "text"
        )
    }
}
