import SwiftUI

/// Generación mínima que impide que un salto viejo reactive el scroll mientras
/// ya existe una petición nueva. También permite probar la carrera sin montar UI.
struct ConversationBottomJumpState: Equatable {
    private(set) var generation: UInt64 = 0
    private(set) var locksUserScrolling = false

    mutating func begin() -> UInt64 {
        generation &+= 1
        locksUserScrolling = true
        return generation
    }

    func isActive(generation expected: UInt64) -> Bool {
        locksUserScrolling && generation == expected
    }

    mutating func finish(generation expected: UInt64) {
        guard generation == expected else { return }
        locksUserScrolling = false
    }

    mutating func cancel() {
        generation &+= 1
        locksUserScrolling = false
    }
}

/// Hace que la flecha flotante gane incluso cuando el usuario todavía está
/// arrastrando o el ScrollView conserva inercia. Al deshabilitar el gesto por un
/// instante, SwiftUI cancela el movimiento pendiente antes del primer salto.
private struct ConversationScrollToBottomControl: ViewModifier {
    @Binding var isNearBottom: Bool
    let onJumpStarted: () -> Void
    let scrollToBottom: () -> Void

    @State private var jumpState = ConversationBottomJumpState()
    @State private var jumpTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .scrollDisabled(jumpState.locksUserScrolling)
            .overlay(alignment: .bottomTrailing) {
                ConversationScrollToBottomButton(
                    isVisible: !isNearBottom,
                    action: startJump
                )
            }
            .onDisappear {
                jumpTask?.cancel()
                jumpTask = nil
                jumpState.cancel()
            }
    }

    private func startJump() {
        jumpTask?.cancel()
        let generation = jumpState.begin()
        onJumpStarted()

        jumpTask = Task { @MainActor in
            // El yield deja que `.scrollDisabled(true)` cancele primero el pan
            // activo. Los intentos posteriores cubren la materialización diferida
            // de LazyVStack y cualquier cambio de tamaño del viewport.
            let delays: [UInt64] = [0, 16_000_000, 48_000_000, 96_000_000]
            for delay in delays {
                if delay == 0 {
                    await Task.yield()
                } else {
                    do {
                        try await Task.sleep(nanoseconds: delay)
                    } catch {
                        return
                    }
                }
                guard jumpState.isActive(generation: generation) else { return }
                scrollToBottom()
            }

            jumpState.finish(generation: generation)
            isNearBottom = true
            jumpTask = nil
        }
    }
}

extension View {
    func conversationScrollToBottomControl(
        isNearBottom: Binding<Bool>,
        onJumpStarted: @escaping () -> Void = {},
        scrollToBottom: @escaping () -> Void
    ) -> some View {
        modifier(ConversationScrollToBottomControl(
            isNearBottom: isNearBottom,
            onJumpStarted: onJumpStarted,
            scrollToBottom: scrollToBottom
        ))
    }
}

private struct ConversationScrollToBottomButton: View {
    let isVisible: Bool
    let action: () -> Void

    var body: some View {
        if isVisible {
            Button(action: action) {
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .padding(12)
            }
            .glassEffect(.regular.interactive(), in: Circle())
            .padding(.trailing, RistakTheme.Spacing.md)
            .padding(.bottom, RistakTheme.Spacing.md)
            .accessibilityLabel("Bajar al final")
            .accessibilityIdentifier("ristak-conversation-scroll-to-bottom")
            .transition(.scale.combined(with: .opacity))
        }
    }
}
