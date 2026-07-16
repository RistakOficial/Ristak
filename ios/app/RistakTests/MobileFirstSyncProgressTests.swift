import XCTest
@testable import Ristak

final class MobileFirstSyncProgressTests: XCTestCase {
    func testStageProgressIsMonotonicAndCompletesAtOneHundredPercent() {
        let fractions = MobileFirstSyncStage.allCases.map(\.fraction)

        XCTAssertEqual(fractions, fractions.sorted())
        XCTAssertEqual(fractions.last, 1)
    }

    func testRetryOnlyAppearsForARealFailure() {
        let active = MobileFirstSyncProgress(stage: .contacts, detail: "Cargando")
        let failed = MobileFirstSyncProgress(
            stage: .contacts,
            detail: "Interrumpido",
            errorMessage: "Sin conexión"
        )

        XCTAssertFalse(active.canRetry)
        XCTAssertTrue(failed.canRetry)
    }

    @MainActor
    func testInboxAndDirectoryPrimariesOverlapInsteadOfAddingTheirWaits() async {
        let probe = MobileFirstSyncOverlapProbe()

        let result = await MobileFirstSyncCoordinator.loadPrimaries(
            directory: {
                await probe.begin()
                try? await Task.sleep(for: .milliseconds(30))
                await probe.end()
                return 42
            },
            inbox: {
                await probe.begin()
                try? await Task.sleep(for: .milliseconds(30))
                await probe.end()
                return true
            }
        )

        let maximumConcurrentLoads = await probe.maximumConcurrentLoads()
        XCTAssertEqual(maximumConcurrentLoads, 2)
        XCTAssertEqual(result.directory, 42)
        XCTAssertTrue(result.inboxLoaded)
    }

    func testSatelliteContextCommitsOnlyForCurrentNamespaceAndGeneration() {
        let token = ChatSatelliteContextLoadToken(
            namespace: "https://cliente.test|user-1",
            generation: 7
        )

        XCTAssertTrue(ChatSatelliteContextCommitPolicy.canCommit(
            token,
            currentNamespace: "https://cliente.test|user-1",
            currentGeneration: 7,
            isCancelled: false
        ))
        XCTAssertFalse(ChatSatelliteContextCommitPolicy.canCommit(
            token,
            currentNamespace: "https://cliente.test|user-2",
            currentGeneration: 7,
            isCancelled: false
        ))
        XCTAssertFalse(ChatSatelliteContextCommitPolicy.canCommit(
            token,
            currentNamespace: "https://cliente.test|user-1",
            currentGeneration: 8,
            isCancelled: false
        ))
        XCTAssertFalse(ChatSatelliteContextCommitPolicy.canCommit(
            token,
            currentNamespace: "https://cliente.test|user-1",
            currentGeneration: 7,
            isCancelled: true
        ))
    }
}

private actor MobileFirstSyncOverlapProbe {
    private var activeLoads = 0
    private var maximumLoads = 0

    func begin() {
        activeLoads += 1
        maximumLoads = max(maximumLoads, activeLoads)
    }

    func end() {
        activeLoads -= 1
    }

    func maximumConcurrentLoads() -> Int {
        maximumLoads
    }
}
