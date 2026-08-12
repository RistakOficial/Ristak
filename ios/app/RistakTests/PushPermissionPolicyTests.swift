import XCTest
@testable import Ristak

final class PushPermissionPolicyTests: XCTestCase {
    func testAutomaticRegistrationNeverRequestsPermission() {
        XCTAssertTrue(PushRegistrar.shouldRegisterAutomatically(for: .granted))
        XCTAssertFalse(PushRegistrar.shouldRegisterAutomatically(for: .notDetermined))
        XCTAssertFalse(PushRegistrar.shouldRegisterAutomatically(for: .denied))
        XCTAssertFalse(PushRegistrar.shouldRegisterAutomatically(for: .unknown))
    }
}
