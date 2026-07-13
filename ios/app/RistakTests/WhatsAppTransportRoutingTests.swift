import XCTest
@testable import Ristak

final class WhatsAppTransportRoutingTests: XCTestCase {
    func testAPIActiveAlwaysWinsEvenWhenReplyWindowIsClosedAndQRIsReady() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(apiAvailable: true, qrReady: true),
            .api
        )
        XCTAssertTrue(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: true,
                replyWindowOpen: false
            )
        )
    }

    func testQRIsUsedWhenOfficialAPIIsUnavailable() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(apiAvailable: false, qrReady: true),
            .qr
        )
        XCTAssertFalse(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: false,
                replyWindowOpen: false
            )
        )
    }

    func testMissingQRNeverChangesAnAvailableAPITransport() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(apiAvailable: true, qrReady: false),
            .api
        )
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(apiAvailable: false, qrReady: false),
            .api
        )
    }
}
