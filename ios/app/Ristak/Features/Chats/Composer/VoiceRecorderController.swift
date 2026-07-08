import AVFoundation
import Foundation
import Observation

/// Grabador de notas de voz (doc 05 §7.3): AAC/m4a con `AVAudioRecorder`
/// (el backend transcodifica a OGG/Opus). Mide `durationMs` en cliente —
/// el backend NO la calcula (gap doc 05 §10.15).
@MainActor
@Observable
final class VoiceRecorderController: NSObject {
    enum Phase: Equatable {
        case idle
        case recording
        /// Grabación terminada, esperando confirmar/enviar o descartar.
        case preview
    }

    private(set) var phase: Phase = .idle
    /// Segundos transcurridos (se actualiza ~20 veces por segundo mientras graba).
    private(set) var elapsedSeconds: TimeInterval = 0
    /// Nivel de metering normalizado 0…1 (última muestra) para el punto rojo vivo.
    private(set) var meterLevel: Double = 0
    /// Historial reciente del nivel REAL del micrófono (0…1). La muestra más
    /// nueva va al final; la onda en vivo la dibuja desplazándose de derecha a
    /// izquierda (paridad /movil: gain real, no animación falsa).
    private(set) var meterSamples: [Double] = []
    /// Grabación pausada por el usuario (sigue en fase `.recording`).
    private(set) var isPaused: Bool = false
    /// Archivo m4a de la última grabación terminada.
    private(set) var recordedFileURL: URL?
    /// Duración medida de la grabación terminada.
    private(set) var recordedDurationMs: Double = 0

    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?

    /// Ventana de muestras visibles de la onda (≈8 s a 50 ms/muestra). Sobra
    /// para llenar el ancho en iPad; el render toma solo las que caben.
    private static let maxMeterSamples = 160

    var isRecording: Bool { phase == .recording }
    var hasPreview: Bool { phase == .preview && recordedFileURL != nil }

    /// Pide permiso de micrófono; `false` = denegado.
    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Inicia una grabación nueva. Lanza error con copy en español si falla.
    func start() throws {
        discard()

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
        try session.setActive(true)

        let filename = "nota-voz-\(Int(Date().timeIntervalSince1970)).m4a"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]

        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            throw NSError(
                domain: "VoiceRecorder",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No se pudo iniciar la grabación. Intenta de nuevo."]
            )
        }

        self.recorder = recorder
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        isPaused = false
        // Base plana de barras mínimas: la onda existe desde el primer instante
        // y crece con la voz real conforme llegan las muestras.
        meterSamples = Array(repeating: 0.05, count: Self.maxMeterSamples)
        phase = .recording
        startMetering()
    }

    /// Pausa o reanuda la grabación en curso (paridad /movil): la onda se
    /// congela/atenúa mientras está en pausa y el reloj deja de avanzar.
    func togglePause() {
        guard phase == .recording, let recorder else { return }
        if isPaused {
            if recorder.record() { isPaused = false }
        } else {
            recorder.pause()
            isPaused = true
        }
    }

    /// Detiene y deja la grabación lista en `preview` (o descarta si es muy corta).
    /// - Returns: `false` si la grabación duró menos del mínimo (600 ms).
    @discardableResult
    func stop() -> Bool {
        guard let recorder, phase == .recording else { return false }
        let duration = recorder.currentTime
        recorder.stop()
        stopMetering()
        isPaused = false
        self.recorder = nil

        let durationMs = duration * 1000
        if durationMs < ChatMediaLimits.minVoiceNoteDurationMs {
            try? FileManager.default.removeItem(at: recorder.url)
            phase = .idle
            elapsedSeconds = 0
            return false
        }

        recordedFileURL = recorder.url
        recordedDurationMs = durationMs
        elapsedSeconds = duration
        phase = .preview
        return true
    }

    /// Cancela la grabación en curso o descarta el preview.
    func discard() {
        if let recorder {
            recorder.stop()
            try? FileManager.default.removeItem(at: recorder.url)
        }
        recorder = nil
        stopMetering()
        isPaused = false
        if let recordedFileURL {
            try? FileManager.default.removeItem(at: recordedFileURL)
        }
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        phase = .idle
    }

    /// Consume el preview (tras enviarlo). El archivo lo limpia el caller
    /// cuando el envío termina.
    func consumePreview() -> (url: URL, durationMs: Double)? {
        guard let url = recordedFileURL, recordedDurationMs > 0 else { return nil }
        let duration = recordedDurationMs
        recordedFileURL = nil
        recordedDurationMs = 0
        elapsedSeconds = 0
        phase = .idle
        return (url, duration)
    }

    // MARK: - Metering

    private func startMetering() {
        meterTask?.cancel()
        meterTask = Task { [weak self] in
            while !Task.isCancelled {
                // ~50 ms → onda fluida (paridad /movil).
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard let self else { return }
                guard self.phase == .recording else { return }
                // En pausa: congela la onda y el reloj; el loop sigue vivo para
                // reanudar sin recrear el temporizador.
                if self.isPaused { continue }
                guard let recorder = self.recorder else { return }
                recorder.updateMeters()
                let power = recorder.averagePower(forChannel: 0) // dBFS -160…0
                // Normalización idéntica a /movil: (power + 60) / 42, clamp 0…1.
                let normalized = max(0, min(1, Double(power + 60) / 42))
                self.meterLevel = normalized
                self.appendMeterSample(normalized)
                self.elapsedSeconds = recorder.currentTime
            }
        }
    }

    /// Empuja una muestra real al historial y descarta las más viejas para que
    /// la onda se desplace de derecha a izquierda.
    private func appendMeterSample(_ value: Double) {
        meterSamples.append(value)
        let overflow = meterSamples.count - Self.maxMeterSamples
        if overflow > 0 {
            meterSamples.removeFirst(overflow)
        }
    }

    private func stopMetering() {
        meterTask?.cancel()
        meterTask = nil
        meterLevel = 0
        meterSamples = []
    }
}
