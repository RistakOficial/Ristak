import XCTest
@testable import Ristak

final class ConversationInitialPresentationTests: XCTestCase {
    func testCachedTimelineWinsOverSecondaryLoadingAndNetworkError() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: "Servidor lento",
            hasLoadedOnce: false,
            isLoadingInitial: true,
            timelineIsEmpty: false
        )

        XCTAssertEqual(state, .content)
    }

    func testPrimaryLoadCompletionShowsContentWhileOtherWorkContinues() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: nil,
            hasLoadedOnce: true,
            isLoadingInitial: true,
            timelineIsEmpty: false
        )

        XCTAssertEqual(state, .content)
    }

    func testLoadingAppearsOnlyWithoutPrimaryContent() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: nil,
            hasLoadedOnce: false,
            isLoadingInitial: true,
            timelineIsEmpty: true
        )

        XCTAssertEqual(state, .loading)
    }
}
