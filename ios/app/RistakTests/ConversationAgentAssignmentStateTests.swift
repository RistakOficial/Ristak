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

    private func state(status: String, signal: String? = nil) throws -> ConversationAgentState {
        var payload: [String: Any] = [
            "contactId": "contact-assignment-test",
            "agentId": "agent-assignment-test",
            "agentName": "Agente de prueba",
            "agentEnabled": true,
            "status": status
        ]
        if let signal { payload["signal"] = signal }
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(ConversationAgentState.self, from: data)
    }
}
