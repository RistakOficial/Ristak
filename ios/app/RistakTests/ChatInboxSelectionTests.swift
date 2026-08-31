import Foundation
import XCTest
@testable import Ristak

final class ChatInboxSelectionTests: XCTestCase {
    func testSelectingAllKeepsOffscreenIDsAndDeduplicates() {
        let selected = ChatInboxSelection.selectingAll([
            "visible-1",
            "offscreen-1",
            " offscreen-2 ",
            "offscreen-1",
            "",
        ])

        XCTAssertEqual(selected, Set(["visible-1", "offscreen-1", "offscreen-2"]))
    }

    func testTogglingVisibleDoesNotDiscardOffscreenSelection() {
        let initial: Set<String> = ["visible-1", "offscreen-1", "offscreen-2"]
        let deselected = ChatInboxSelection.togglingVisible(
            selected: initial,
            visible: ["visible-1"]
        )
        XCTAssertEqual(deselected, Set(["offscreen-1", "offscreen-2"]))

        let reselected = ChatInboxSelection.togglingVisible(
            selected: deselected,
            visible: ["visible-1", "visible-2"]
        )
        XCTAssertEqual(reselected, Set(["offscreen-1", "offscreen-2", "visible-1", "visible-2"]))
    }

    func testChatbotFilterIncludesOnlyActivePausedOrUnreviewedGoals() throws {
        let pending = try decodeContact(
            id: "goal-pending",
            agentGoalCompletedUnreviewed: true
        )
        let normal = try decodeContact(
            id: "normal",
            agentGoalCompletedUnreviewed: false
        )
        let active = try decodeAgentState(contactID: normal.id, status: "active")
        let paused = try decodeAgentState(contactID: normal.id, status: "paused")

        XCTAssertTrue(ChatbotInboxVisibility.matches(contact: pending, states: [], statusFilter: .all))
        XCTAssertTrue(ChatbotInboxVisibility.matches(contact: normal, states: [active], statusFilter: .active))
        XCTAssertTrue(ChatbotInboxVisibility.matches(contact: normal, states: [paused], statusFilter: .paused))
        XCTAssertFalse(ChatbotInboxVisibility.matches(contact: normal, states: [], statusFilter: .all))
        XCTAssertFalse(ChatbotInboxVisibility.matches(contact: normal, states: [active], statusFilter: .completed))
        XCTAssertEqual(
            ChatInboxFilter(chipID: "chatbot"),
            .quick(.chatbot)
        )
        XCTAssertTrue(ChatInboxFilter.quick(.chatbot).usesGoalCompletedServerScope)
    }

    func testMissingGoalReviewFlagDefaultsToFalse() throws {
        let contact = try JSONDecoder().decode(
            ChatContact.self,
            from: Data(#"{"id":"legacy-chat"}"#.utf8)
        )

        XCTAssertFalse(contact.agentGoalCompletedUnreviewed)
    }

    func testFilterCountersUseVisibleConversationsInsteadOfMessageOrStoredIDTotals() throws {
        let rows = try [
            decodeCountContact(id: "unread-1", unread: 1),
            decodeCountContact(id: "unread-40", unread: 40),
            decodeCountContact(id: "archived-visible", unread: 8),
            decodeCountContact(id: "outbound", unread: 7, direction: "outbound"),
            decodeCountContact(
                id: "comment-only",
                unread: 5,
                hasCommentMessage: true,
                hasPrivateDm: false
            ),
        ]
        let archivedIDs = Set(["archived-visible", "archived-stale-1", "archived-stale-2"])

        XCTAssertEqual(
            ChatInboxCountPolicy.unreadMessageTotal(
                in: rows,
                archivedIDs: archivedIDs,
                manuallyUnreadIDs: ["outbound"]
            ),
            41
        )
        XCTAssertEqual(
            ChatInboxCountPolicy.unreadConversationCount(
                in: rows,
                archivedIDs: archivedIDs,
                manuallyUnreadIDs: ["outbound"]
            ),
            2
        )
        XCTAssertEqual(
            ChatInboxCountPolicy.loadedArchivedConversationCount(
                in: rows,
                archivedIDs: archivedIDs
            ),
            1
        )
    }

    private func decodeContact(
        id: String,
        agentGoalCompletedUnreviewed: Bool
    ) throws -> ChatContact {
        try JSONDecoder().decode(
            ChatContact.self,
            from: Data("""
            {
              "id": "\(id)",
              "agentGoalCompletedUnreviewed": \(agentGoalCompletedUnreviewed)
            }
            """.utf8)
        )
    }

    private func decodeAgentState(contactID: String, status: String) throws -> ConversationAgentState {
        try JSONDecoder().decode(
            ConversationAgentState.self,
            from: Data(#"{"contactId":"\#(contactID)","status":"\#(status)"}"#.utf8)
        )
    }


    private func decodeCountContact(
        id: String,
        unread: Int,
        direction: String = "inbound",
        hasCommentMessage: Bool = false,
        hasPrivateDm: Bool = false
    ) throws -> ChatContact {
        try JSONDecoder().decode(
            ChatContact.self,
            from: Data("""
            {
              "id": "\(id)",
              "lastMessageDirection": "\(direction)",
              "unreadCount": \(unread),
              "hasCommentMessage": \(hasCommentMessage),
              "hasPrivateDm": \(hasPrivateDm)
            }
            """.utf8)
        )
    }
}
