import Foundation
import XCTest
@testable import Ristak

final class SessionIsolationAndFallbackTests: XCTestCase {
    func testSnapshotNamespacesFailClosedWithoutVerifiedIdentity() {
        let baseURL = URL(string: "https://tenant.example.test")

        XCTAssertNil(RistakSnapshotCache.namespace(baseURL: baseURL, userID: nil))
        XCTAssertNil(RistakSnapshotCache.namespace(baseURL: baseURL, userID: "  "))
        XCTAssertNil(RistakSnapshotCache.namespace(baseURL: nil, userID: "user-1"))
        XCTAssertEqual(
            RistakSnapshotCache.namespace(baseURL: baseURL, userID: "user-1"),
            "tenant.example.test.user-1"
        )
    }

    func testChatLocalNamespaceAlsoRequiresIdentity() {
        let baseURL = URL(string: "https://tenant.example.test")

        XCTAssertNil(ChatAccountNamespace.make(baseURL: baseURL, userID: nil))
        XCTAssertEqual(
            ChatAccountNamespace.make(baseURL: baseURL, userID: "user-1"),
            "tenant.example.test|user-1"
        )
    }

    func testConversationFallbackOnlyHandlesMissingDedicatedRoute() {
        let notFound = RistakAPIError(
            kind: .notFound,
            status: 404,
            message: "No existe"
        )
        let unavailable = RistakAPIError(
            kind: .server,
            status: 503,
            message: "Arrancando"
        )
        let unauthorized = RistakAPIError(
            kind: .unauthorized,
            status: 401,
            message: "Sesión vencida"
        )

        XCTAssertTrue(JourneyService.canUseLegacyConversationFallback(notFound))
        XCTAssertFalse(JourneyService.canUseLegacyConversationFallback(unavailable))
        XCTAssertFalse(JourneyService.canUseLegacyConversationFallback(unauthorized))
    }
}
