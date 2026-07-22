import XCTest
@testable import Ristak

final class ConversationAgentAssignmentStateTests: XCTestCase {
    func testOnlyActiveAndPausedStatesRemainAssigned() throws {
        XCTAssertTrue(try state(status: "active").isAssignedExistingAgent)
        XCTAssertTrue(try state(status: "paused").isAssignedExistingAgent)

        for terminalStatus in ["human", "skipped", "completed", "discarded"] {
            XCTAssertFalse(try state(status: terminalStatus).isAssignedExistingAgent)
        }
    }

    func testPausedAssignmentIsExposedForTheCombinedRobotIndicator() throws {
        XCTAssertTrue(try state(status: "paused").isPausedAssignment)
        XCTAssertFalse(try state(status: "active").isPausedAssignment)
        XCTAssertFalse(try state(status: "human").isPausedAssignment)
    }

    func testTerminalSignalKeepsItsHumanNoticeWithoutRemainingAssigned() throws {
        let completed = try state(status: "completed", signal: "ready_for_human")

        XCTAssertTrue(completed.referencesExistingAgent)
        XCTAssertTrue(completed.hasPendingSignal)
        XCTAssertFalse(completed.isAssignedExistingAgent)
    }

    func testChannelRowsForTheSameAgentCountAsOneAssignment() throws {
        let whatsapp = try state(status: "active", updatedAt: "2026-07-22T12:00:00Z")
        let sms = try state(status: "active", updatedAt: "2026-07-22T12:00:01Z")

        let assigned = ConversationAgentState.uniqueAssignedStates(from: [whatsapp, sms])

        XCTAssertEqual(assigned.count, 1)
        XCTAssertEqual(assigned.first?.updatedAt, "2026-07-22T12:00:01Z")
    }

    func testActiveChannelStateWinsOverPausedDuplicate() throws {
        let active = try state(status: "active", updatedAt: "2026-07-22T12:00:00Z")
        let paused = try state(status: "paused", updatedAt: "2026-07-22T12:01:00Z")

        let assigned = ConversationAgentState.uniqueAssignedStates(from: [paused, active])

        XCTAssertEqual(assigned.count, 1)
        XCTAssertEqual(assigned.first?.status, "active")
    }

    private func state(
        status: String,
        signal: String? = nil,
        updatedAt: String? = nil
    ) throws -> ConversationAgentState {
        var payload: [String: Any] = [
            "contactId": "contact-assignment-test",
            "agentId": "agent-assignment-test",
            "agentName": "Agente de prueba",
            "agentEnabled": true,
            "status": status
        ]
        if let signal { payload["signal"] = signal }
        if let updatedAt { payload["updatedAt"] = updatedAt }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(ConversationAgentState.self, from: data)
    }
}
