import Foundation
import MetricKit
import OSLog
import SwiftUI

/// Operaciones cerradas que se pueden medir sin adjuntar información de clientes.
///
/// La telemetría nunca acepta nombres, teléfonos, contenido de mensajes, tokens,
/// URLs ni identificadores de cuenta/contacto. Los únicos valores públicos en el
/// Unified Log son categorías conocidas, duraciones, conteos y resultados.
enum RistakPerformanceOperation: String, Codable, Sendable {
    case appLaunch = "app_launch"
    case chatInboxLoad = "chat_inbox_load"
    case contactDirectory = "contact_directory"
    case conversationInitialLoad = "conversation_initial_load"
    case calendarsLoad = "calendars_load"
    case paymentsLoad = "payments_load"
    case analyticsLoad = "analytics_load"
    case mediaUpload = "media_upload"

    var signpostName: StaticString {
        switch self {
        case .appLaunch: "AppLaunch"
        case .chatInboxLoad: "ChatInboxLoad"
        case .contactDirectory: "ContactDirectory"
        case .conversationInitialLoad: "ConversationInitialLoad"
        case .calendarsLoad: "CalendarsLoad"
        case .paymentsLoad: "PaymentsLoad"
        case .analyticsLoad: "AnalyticsLoad"
        case .mediaUpload: "MediaUpload"
        }
    }
}

enum RistakPerformanceOutcome: String, Codable, Sendable {
    case success
    case cancelled
    case timeout
    case unavailable
    case failed
}

/// Un intervalo de rendimiento que puede cerrarse desde el punto que termina la
/// operación. Solo conserva tiempo monotónico y un ID de signpost local.
struct RistakPerformanceSpan {
    fileprivate let operation: RistakPerformanceOperation
    fileprivate let signpostID: OSSignpostID
    fileprivate let startedAtNanoseconds: UInt64

    func finish(
        outcome: RistakPerformanceOutcome,
        itemCount: Int = 0
    ) {
        RistakObservability.finish(self, outcome: outcome, itemCount: itemCount)
    }
}

/// Entrada única para MetricKit, Unified Logging y signposts de Instruments.
///
/// MetricKit recolecta automáticamente arranques, hangs, CPU, memoria y disco.
/// Aquí solo se registra un resumen numérico cuando iOS entrega el reporte; el
/// payload crudo y sus call stacks nunca se imprimen ni se envían por red.
enum RistakObservability {
    nonisolated static let subsystem = "com.ristak.app"

    /// El handle de MetricKit mantiene los intervalos visibles en Instruments y
    /// además los agrega como `MXSignpostMetric` en el reporte diario.
    fileprivate nonisolated static let performanceLog = MXMetricManager.makeLogHandle(
        category: "performance"
    )
    fileprivate nonisolated static let performanceLogger = Logger(
        subsystem: subsystem,
        category: "performance"
    )
    fileprivate nonisolated static let metricKitLogger = Logger(
        subsystem: subsystem,
        category: "metrickit"
    )
    private nonisolated static let lifecycleLogger = Logger(
        subsystem: subsystem,
        category: "lifecycle"
    )
    private nonisolated static let pushLogger = Logger(
        subsystem: subsystem,
        category: "push"
    )

    @MainActor private static var didBootstrap = false
    @MainActor private static var launchSpan: RistakPerformanceSpan?

    /// Se llama una sola vez desde el punto de entrada de la app.
    @MainActor
    static func bootstrap() {
        guard !didBootstrap else { return }
        didBootstrap = true

        RistakMetricKitSubscriber.shared.start()
        launchSpan = begin(.appLaunch)
        lifecycleLogger.notice("application_bootstrap_started")
        persist(.lifecycle(.bootstrapStarted))
    }

    /// Se dispara al presentar la primera jerarquía SwiftUI utilizable.
    @MainActor
    static func applicationUIReady() {
        guard let span = launchSpan else { return }
        launchSpan = nil
        span.finish(outcome: .success)
        lifecycleLogger.notice("application_ui_ready")
        persist(.lifecycle(.contentReady))
    }

    /// Inicia un intervalo de rendimiento sin aceptar metadata arbitraria.
    nonisolated static func begin(
        _ operation: RistakPerformanceOperation
    ) -> RistakPerformanceSpan {
        let signpostID = OSSignpostID(log: performanceLog)
        mxSignpost(
            .begin,
            log: performanceLog,
            name: operation.signpostName,
            signpostID: signpostID
        )
        return RistakPerformanceSpan(
            operation: operation,
            signpostID: signpostID,
            startedAtNanoseconds: DispatchTime.now().uptimeNanoseconds
        )
    }

    fileprivate nonisolated static func finish(
        _ span: RistakPerformanceSpan,
        outcome: RistakPerformanceOutcome,
        itemCount: Int
    ) {
        let elapsedNanoseconds = DispatchTime.now().uptimeNanoseconds
            &- span.startedAtNanoseconds
        let durationMilliseconds = Double(elapsedNanoseconds) / 1_000_000
        let safeItemCount = max(itemCount, 0)

        // Los valores se guardan en Logger/ring. El signpost de MetricKit se
        // deja sin formato custom para conservar su snapshot CPU/memoria y
        // evitar pasar un String Swift a un especificador C `%s`.
        mxSignpost(
            .end,
            log: performanceLog,
            name: span.operation.signpostName,
            signpostID: span.signpostID
        )
        performanceLogger.info(
            "operation=\(span.operation.rawValue, privacy: .public) outcome=\(outcome.rawValue, privacy: .public) duration_ms=\(durationMilliseconds, privacy: .public) items=\(safeItemCount, privacy: .public)"
        )
        persist(.performance(
            operation: span.operation,
            outcome: outcome,
            durationMilliseconds: Int(durationMilliseconds.rounded()),
            itemCount: safeItemCount
        ))
    }

    /// Snapshot sanitizado para soporte o pruebas. Nunca contiene texto libre.
    nonisolated static func recentDiagnostics() async -> [RistakDiagnosticRecord] {
        await RistakDiagnosticRingBuffer.shared.snapshot()
    }

    /// Evento cerrado de push. No acepta token, payload, contacto ni texto.
    nonisolated static func recordPush(
        _ milestone: RistakDiagnosticRecord.PushMilestone
    ) {
        pushLogger.notice("milestone=\(milestone.rawValue, privacy: .public)")
        persist(.push(milestone))
    }

    fileprivate nonisolated static func persist(_ record: RistakDiagnosticRecord) {
        Task.detached(priority: .utility) {
            await RistakDiagnosticRingBuffer.shared.append(record)
        }
    }
}

private final class RistakMetricKitSubscriber: NSObject, MXMetricManagerSubscriber {
    @MainActor static let shared = RistakMetricKitSubscriber()

    @MainActor private var isStarted = false

    @MainActor
    func start() {
        guard !isStarted else { return }
        isStarted = true
        MXMetricManager.shared.add(self)
    }

    nonisolated func didReceive(_ payloads: [MXMetricPayload]) {
        // Deliberadamente no serializamos `jsonRepresentation()`: puede incluir
        // símbolos y datos diagnósticos que no necesitamos para medir salud.
        RistakObservability.metricKitLogger.notice(
            "metric_payloads_received count=\(payloads.count, privacy: .public)"
        )
        RistakObservability.persist(.metricPayload(count: payloads.count))
    }

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let crashes = payloads.reduce(0) {
            $0 + ($1.crashDiagnostics?.count ?? 0)
        }
        let hangs = payloads.reduce(0) {
            $0 + ($1.hangDiagnostics?.count ?? 0)
        }
        let cpuExceptions = payloads.reduce(0) {
            $0 + ($1.cpuExceptionDiagnostics?.count ?? 0)
        }
        let diskWriteExceptions = payloads.reduce(0) {
            $0 + ($1.diskWriteExceptionDiagnostics?.count ?? 0)
        }

        RistakObservability.metricKitLogger.error(
            "diagnostic_payloads_received payloads=\(payloads.count, privacy: .public) crashes=\(crashes, privacy: .public) hangs=\(hangs, privacy: .public) cpu_exceptions=\(cpuExceptions, privacy: .public) disk_write_exceptions=\(diskWriteExceptions, privacy: .public)"
        )
        RistakObservability.persist(.metricDiagnostic(
            payloadCount: payloads.count,
            crashCount: crashes,
            hangCount: hangs,
            cpuExceptionCount: cpuExceptions,
            diskWriteExceptionCount: diskWriteExceptions
        ))
    }
}

private struct RistakUIReadyTelemetryModifier: ViewModifier {
    @State private var didReport = false

    func body(content: Content) -> some View {
        content.onAppear {
            guard !didReport else { return }
            didReport = true
            RistakObservability.applicationUIReady()
        }
    }
}

extension View {
    func reportsRistakUIReady() -> some View {
        modifier(RistakUIReadyTelemetryModifier())
    }
}
