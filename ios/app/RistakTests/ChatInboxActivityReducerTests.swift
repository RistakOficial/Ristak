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

    func testDirectorySeedCreatesImmediateRowForFirstOutboundMessage() throws {
        let existing = try contact(id: "existing", date: "2026-07-10T12:00:00Z", unread: 0)
        let seed = try contact(id: "new-contact", date: "", unread: 0)
        let activity = ChatInboxActivity(message: message(
            id: "outbound-new",
            contactID: seed.id,
            date: "2026-07-10T13:00:00Z",
            direction: .outbound,
            text: "Primer mensaje"
        ))

        let reduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: [existing],
            seedContact: seed,
            isDuplicate: false
        ))

        XCTAssertTrue(reduction.promoted)
        XCTAssertEqual(reduction.rows.map(\.id), ["new-contact", "existing"])
        XCTAssertEqual(reduction.rows[0].lastMessageText, "Primer mensaje")
    }

    func testHydratedUnknownInboundCreatesRowAndCountsUnread() throws {
        let existing = try contact(id: "existing", date: "2026-07-10T12:00:00Z", unread: 0)
        let hydrated = try contact(id: "outside-first-page", date: "", unread: 0)
        let activity = ChatInboxActivity(
            message: message(
                id: "inbound-outside-page",
                contactID: hydrated.id,
                date: "2026-07-10T13:00:00Z",
                direction: .inbound,
                text: "Mensaje nuevo"
            ),
            conversationIsVisible: false
        )

        XCTAssertNil(ChatInboxActivityReducer.apply(
            activity,
            to: [existing],
            isDuplicate: false
        ))
        let reduction = try XCTUnwrap(ChatInboxActivityReducer.apply(
            activity,
            to: [existing],
            seedContact: hydrated,
            isDuplicate: false
        ))

        XCTAssertEqual(reduction.rows.map(\.id), [hydrated.id, existing.id])
        XCTAssertEqual(reduction.rows.first?.lastMessageText, "Mensaje nuevo")
        XCTAssertEqual(reduction.rows.first?.unreadCount, 1)
    }

    func testUnknownActivityBufferCoalescesFetchBatchAndUnread() {
        var buffer = ChatUnknownActivityBuffer()
        let first = ChatInboxActivity(
            message: message(
                id: "unknown-1",
                contactID: "outside-first-page",
                date: "2026-07-10T13:00:00Z",
                direction: .inbound,
                text: "Uno"
            ),
            conversationIsVisible: false
        )
        let second = ChatInboxActivity(
            message: message(
                id: "unknown-2",
                contactID: "outside-first-page",
                date: "2026-07-10T13:00:01Z",
                direction: .inbound,
                text: "Dos"
            ),
            conversationIsVisible: false
        )

        XCTAssertTrue(buffer.enqueue(first).accepted)
        XCTAssertFalse(buffer.enqueue(first).accepted)
        XCTAssertTrue(buffer.enqueue(first.withConversationVisible()).accepted)
        XCTAssertTrue(buffer.enqueue(second).accepted)
        XCTAssertEqual(buffer.contactIDs, ["outside-first-page"])

        let batch = buffer.take(contactID: "outside-first-page")
        XCTAssertEqual(batch?.activities.map(\.messageID), ["unknown-1", "unknown-2"])
        XCTAssertEqual(batch?.activities.first?.conversationIsVisible, true)
        XCTAssertEqual(batch?.pendingInboundCount, 1)
        XCTAssertTrue(buffer.isEmpty)
    }

    func testAuthoritativeRefreshKeepsPersistedAlternateDestination() throws {
        var navigationSeed = try contact(id: "contact-1", date: "", unread: 0)
        navigationSeed.matchedPhone = "+5215550002222"
        var refreshed = try contact(
            id: "contact-1",
            date: "2026-07-10T14:00:00Z",
            unread: 0
        )
        refreshed.lastMessageText = "Fila REST fresca"

        let resolved = ChatNavigationDestinationResolver.resolve(
            authoritativeRow: refreshed,
            navigationSeed: nil,
            directorySeed: nil,
            persistedPhone: navigationSeed.matchedPhone,
            persistedPhoneIsValidated: true
        )

        XCTAssertEqual(resolved?.lastMessageText, "Fila REST fresca")
        XCTAssertEqual(resolved?.matchedPhone, "+5215550002222")
        XCTAssertFalse(resolved?.destinationPhoneRequiresValidation ?? true)
    }

    func testPersistedDestinationIsRejectedWhenFreshInventoryRemovedIt() throws {
        let json = """
        {
          "id": "contact-1",
          "name": "Contacto 1",
          "phone": "+5215550001111",
          "phones": [
            { "id": "primary", "phone": "+5215550001111", "isPrimary": true }
          ]
        }
        """
        let fresh = try JSONDecoder().decode(ChatContact.self, from: Data(json.utf8))

        let resolved = ChatNavigationDestinationResolver.resolve(
            authoritativeRow: fresh,
            navigationSeed: nil,
            directorySeed: nil,
            persistedPhone: "+5215550002222",
            persistedPhoneIsValidated: true
        )

        XCTAssertNil(resolved?.matchedPhone)
        XCTAssertFalse(resolved?.destinationPhoneRequiresValidation ?? true)
    }

    func testPersistedDestinationWaitsForFreshValidation() throws {
        let cached = try contact(id: "contact-1", date: "2026-07-10T12:00:00Z", unread: 0)
        let resolved = ChatNavigationDestinationResolver.resolve(
            authoritativeRow: cached,
            navigationSeed: nil,
            directorySeed: nil,
            persistedPhone: "+5215550002222"
        )

        XCTAssertEqual(resolved?.matchedPhone, "+5215550002222")
        XCTAssertTrue(resolved?.destinationPhoneRequiresValidation ?? false)
    }

    @MainActor
    func testConversationCannotSendToUnvalidatedPersistedDestination() throws {
        var cached = try contact(id: "contact-1", date: "2026-07-10T12:00:00Z", unread: 0)
        cached.matchedPhone = "+5215550002222"
        cached.destinationPhoneRequiresValidation = true

        let conversation = ConversationViewModel(
            contactID: cached.id,
            seedContact: cached,
            onInboxActivity: { _ in }
        )

        XCTAssertNil(conversation.contactPhone)
    }

    func testOldServerRowAddsOnlyUnacknowledgedBufferedUnread() throws {
        var oldRow = try contact(
            id: "outside-first-page",
            date: "2026-07-10T12:00:00Z",
            unread: 5
        )
        let first = ChatInboxActivity(
            message: message(
                id: "unknown-1",
                contactID: oldRow.id,
                date: "2026-07-10T13:00:00Z",
                direction: .inbound,
                text: "Uno"
            ),
            conversationIsVisible: false
        )
        let second = ChatInboxActivity(
            message: message(
                id: "unknown-2",
                contactID: oldRow.id,
                date: "2026-07-10T13:01:00Z",
                direction: .inbound,
                text: "Dos"
            ),
            conversationIsVisible: false
        )

        for activity in [first, second] {
            let contained = ChatInboxServerReconciliation.contains(activity, in: oldRow)
            oldRow = try XCTUnwrap(ChatInboxActivityReducer.apply(
                activity,
                to: [oldRow],
                isDuplicate: contained
            )).updatedContact
        }

        XCTAssertEqual(oldRow.unreadCount, 7)
        XCTAssertEqual(oldRow.lastMessageText, "Dos")
    }

    func testTenThousandRowsSustainRepeatedProductionReductions() throws {
        let payload = (0..<10_000).map { index in
            """
            {
              "id":"contact-\(index)",
              "name":"Contacto \(index)",
              "phone":"+52000\(String(format: "%07d", index))",
              "lastMessageText":"Mensaje \(index)",
              "lastMessageType":"text",
              "lastMessageChannel":"whatsapp",
              "lastMessageTransport":"api",
              "lastMessageDirection":"inbound",
              "lastMessageDate":"2026-07-10T12:00:00Z",
              "unreadCount":0
            }
            """
        }.joined(separator: ",")
        var rows = try JSONDecoder().decode(
            [ChatContact].self,
            from: Data("[\(payload)]".utf8)
        )
        let startedAt = Date()
        var expectedFirstID = ""

        for iteration in 0..<250 {
            let index = 9_999 - (iteration % 1_000)
            expectedFirstID = "contact-\(index)"
            let activity = ChatInboxActivity(message: message(
                id: "soak-\(iteration)",
                contactID: expectedFirstID,
                date: "2026-07-10T13:\(String(format: "%02d", iteration % 60)):00Z",
                direction: .outbound,
                text: "Soak \(iteration)"
            ))
            rows = try XCTUnwrap(ChatInboxActivityReducer.apply(
                activity,
                to: rows,
                isDuplicate: false
            )).rows
        }

        XCTAssertEqual(rows.count, 10_000)
        XCTAssertEqual(Set(rows.map(\.id)).count, 10_000)
        XCTAssertEqual(rows.first?.id, expectedFirstID)
        XCTAssertLessThan(
            Date().timeIntervalSince(startedAt),
            8,
            "250 promociones reales sobre 10k filas deben conservar respuesta interactiva."
        )
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
