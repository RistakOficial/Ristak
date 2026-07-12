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
}
