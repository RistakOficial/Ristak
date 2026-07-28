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

    func testGoalCompletedQuickFilterMatchesOnlyUnreviewedAgentGoals() throws {
        let pending = try decodeContact(
            id: "goal-pending",
            agentGoalCompletedUnreviewed: true
        )
        let reviewed = try decodeContact(
            id: "goal-reviewed",
            agentGoalCompletedUnreviewed: false
        )

        XCTAssertTrue(ChatRowSignals.matchesQuick(.goalCompleted, contact: pending))
        XCTAssertFalse(ChatRowSignals.matchesQuick(.goalCompleted, contact: reviewed))
        XCTAssertEqual(
            ChatInboxFilter(chipID: "goal_completed"),
            .quick(.goalCompleted)
        )
    }

    func testMissingGoalReviewFlagDefaultsToFalse() throws {
        let contact = try JSONDecoder().decode(
            ChatContact.self,
            from: Data(#"{"id":"legacy-chat"}"#.utf8)
        )

        XCTAssertFalse(contact.agentGoalCompletedUnreviewed)
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
}
