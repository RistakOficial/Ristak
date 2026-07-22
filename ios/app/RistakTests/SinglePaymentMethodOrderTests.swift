import XCTest
@testable import Ristak

@MainActor
final class SinglePaymentMethodOrderTests: XCTestCase {
    func testManualPaymentIsListedBeforeLinkAndSavedCard() {
        XCTAssertEqual(
            SinglePaymentModel.Method.displayOrder,
            [.manual, .link, .savedCard]
        )
    }
}
