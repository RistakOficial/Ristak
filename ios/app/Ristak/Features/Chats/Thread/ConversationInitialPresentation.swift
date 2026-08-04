import Foundation

/// Estado puro que decide qué pinta el hilo durante el arranque. La carga de
/// agente, detalle de contacto, números u otros satélites no forma parte del
/// input: una timeline viva o un fallback cacheado ya revelado manda sobre los
/// estados secundarios de carga y error.
enum ConversationInitialPresentation: Equatable {
    case accessDenied
    case error(String)
    case loading
    case content

    static func resolve(
        accessDenied: Bool,
        loadErrorMessage: String?,
        hasLoadedOnce: Bool,
        isLoadingInitial: Bool,
        timelineIsEmpty: Bool
    ) -> ConversationInitialPresentation {
        if accessDenied { return .accessDenied }

        // El contenido primario gana sobre fallos/cargas secundarias. Esto
        // conserva visible el fallback mientras la red o satélites terminan.
        if hasLoadedOnce || !timelineIsEmpty { return .content }

        if let loadErrorMessage { return .error(loadErrorMessage) }
        if isLoadingInitial { return .loading }
        return .content
    }
}
