import XCTest
@testable import Ristak

final class ConversationInitialPresentationTests: XCTestCase {
    func testCachedTimelineWinsOverSecondaryLoadingAndNetworkError() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: "Servidor lento",
            hasLoadedOnce: false,
            timelineIsEmpty: false
        )

        XCTAssertEqual(state, .content)
    }

    func testPrimaryLoadCompletionShowsContentWhileOtherWorkContinues() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: nil,
            hasLoadedOnce: true,
            timelineIsEmpty: false
        )

        XCTAssertEqual(state, .content)
    }

    func testFirstFrameWaitsForPrimaryContent() {
        let state = ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: nil,
            hasLoadedOnce: false,
            timelineIsEmpty: true
        )

        XCTAssertEqual(state, .loading)
    }

    func testConfirmedEmptyThreadShowsItsEmptyState() {
        XCTAssertEqual(ConversationInitialPresentation.resolve(
            accessDenied: false,
            loadErrorMessage: nil,
            hasLoadedOnce: true,
            timelineIsEmpty: true
        ), .content)
    }

    func testDefinitiveMissingContactShowsRetryEvenIfAStoredTimelineWasAlreadyVisible() {
        XCTAssertEqual(ConversationInitialPresentation.resolve(
            accessDenied: false, loadErrorMessage: "Contacto no encontrado",
            hasLoadedOnce: true, timelineIsEmpty: false, blocksCachedHistory: true
        ), .error("Contacto no encontrado"))
    }
}
