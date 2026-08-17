import XCTest
@testable import Ristak

final class WhatsAppTransportRoutingTests: XCTestCase {
    func testClosedReplyWindowUsesReadyQRInsteadOfBlockingForTemplate() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(
                apiAvailable: true,
                qrReady: true,
                replyWindowOpen: false
            ),
            .qr
        )
        XCTAssertFalse(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: true,
                qrReady: true,
                replyWindowOpen: false
            )
        )
    }

    func testOpenReplyWindowKeepsOfficialAPIAsPrimaryTransport() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(
                apiAvailable: true,
                qrReady: true,
                replyWindowOpen: true
            ),
            .api
        )
        XCTAssertFalse(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: true,
                qrReady: true,
                replyWindowOpen: true
            )
        )
    }

    func testQRIsUsedWhenOfficialAPIIsUnavailable() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(
                apiAvailable: false,
                qrReady: true,
                replyWindowOpen: true
            ),
            .qr
        )
        XCTAssertFalse(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: false,
                qrReady: true,
                replyWindowOpen: false
            )
        )
    }

    func testClosedReplyWindowRequiresTemplateWhenQRIsMissing() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(
                apiAvailable: true,
                qrReady: false,
                replyWindowOpen: false
            ),
            .api
        )
        XCTAssertTrue(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: true,
                qrReady: false,
                replyWindowOpen: false
            )
        )
    }

    func testMissingAPIAndQRKeepsAPIRouteForCanonicalBackendError() {
        XCTAssertEqual(
            WhatsAppReplyWindowRules.resolveTransport(
                apiAvailable: false,
                qrReady: false,
                replyWindowOpen: false
            ),
            .api
        )
        XCTAssertFalse(
            WhatsAppReplyWindowRules.requiresOfficialTemplate(
                apiAvailable: false,
                qrReady: false,
                replyWindowOpen: false
            )
        )
    }
}
