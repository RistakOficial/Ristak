import XCTest
@testable import Ristak

@MainActor
final class AppConfigDefaultsTests: XCTestCase {
    func testAIReplySuggestionsAreOptIn() {
        let store = AppConfigStore()

        XCTAssertFalse(store.aiReplySuggestionsEnabled)
        XCTAssertFalse(RistakAppConfigDefaults.aiReplySuggestionsEnabled)
    }
}
