import XCTest
@testable import Ristak

final class ChatRealtimeEventTests: XCTestCase {
    func testScheduledMessageDataChangeDecodesAsRealtimeNudge() throws {
        let frame = RistakServerSentEvent(
            name: "chat_data_changed",
            data: """
            {
              "type": "chat_data_changed",
              "contactId": "contact-123",
              "domains": ["scheduled_messages"],
              "entityId": "scheduled-456",
              "changedAt": "2026-07-16T18:00:00.000Z"
            }
            """
        )

        let event = try XCTUnwrap(ChatRealtimeEvent(frame: frame))
        guard case .dataChanged(let payload) = event else {
            return XCTFail("El frame debe decodificarse como chat_data_changed")
        }

        XCTAssertEqual(payload.contactId, "contact-123")
        XCTAssertEqual(payload.domains, ["scheduled_messages"])
        XCTAssertEqual(payload.entityId, "scheduled-456")
    }
}
