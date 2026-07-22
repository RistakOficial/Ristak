import XCTest
@testable import Ristak

final class ContainedChipLayoutTests: XCTestCase {
    func testRestingInsetMatchesSectionCardContentInset() {
        XCTAssertEqual(
            RistakContainedChipLayout.restingInset,
            RistakTheme.Spacing.md
        )
    }
}
