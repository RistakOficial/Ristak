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

    @MainActor
    func testDetachedSnapshotWriteCannotCrossSessionNamespace() {
        let cache = RistakSnapshotCache.shared
        cache.reset()
        defer { cache.reset() }

        cache.configure(namespace: "tenant-a.user-a")
        let staleToken = cache.namespaceToken()
        XCTAssertNotNil(staleToken)

        cache.configure(namespace: "tenant-b.user-b")
        cache.storeRaw(Data("old-account".utf8), for: "chat:thread:1", ifCurrent: staleToken!)
        XCTAssertNil(cache.rawData(for: "chat:thread:1"))

        let currentToken = cache.namespaceToken()
        XCTAssertNotNil(currentToken)
        cache.storeRaw(Data("current-account".utf8), for: "chat:thread:1", ifCurrent: currentToken!)
        XCTAssertEqual(cache.rawData(for: "chat:thread:1"), Data("current-account".utf8))
    }

    @MainActor
    func testDetachedSnapshotWriteCannotReturnAfterSameAccountRelogin() {
        let cache = RistakSnapshotCache.shared
        cache.reset()
        defer { cache.reset() }

        cache.configure(namespace: "tenant-a.same-user")
        let staleToken = cache.namespaceToken()
        XCTAssertNotNil(staleToken)

        cache.reset()
        cache.configure(namespace: "tenant-a.same-user")
        cache.storeRaw(Data("stale-session".utf8), for: "chat:thread:1", ifCurrent: staleToken!)
        XCTAssertNil(cache.rawData(for: "chat:thread:1"))

        let currentToken = cache.namespaceToken()
        XCTAssertNotNil(currentToken)
        cache.storeRaw(Data("new-session".utf8), for: "chat:thread:1", ifCurrent: currentToken!)
        XCTAssertEqual(cache.rawData(for: "chat:thread:1"), Data("new-session".utf8))
    }

    @MainActor
    func testAlternateDestinationPhonePersistsPerAccount() {
        let namespace = "test-destination-\(UUID().uuidString)"
        let contactID = "contact-1"
        let store = ChatLocalStateStore()
        store.configure(namespace: namespace)
        store.setDestinationPhone("+5215550002222", for: contactID)

        store.configure(namespace: nil)
        XCTAssertNil(store.destinationPhone(for: contactID))
        store.configure(namespace: namespace)
        XCTAssertEqual(store.destinationPhone(for: contactID), "+5215550002222")

        store.setDestinationPhone(nil, for: contactID)
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

    func testConversationMarkersUseLightweightChatActivityContract() {
        let query = JourneyService.chatActivityQuery(limit: 75)

        XCTAssertEqual(query["chatActivityOnly"] ?? nil, "true")
        XCTAssertEqual(query["messageLimit"] ?? nil, "75")
        XCTAssertNil(query["chatMessagesOnly"] ?? nil)
        XCTAssertNil(query["includeBusinessMessages"] ?? nil)
    }
}
