import Foundation
import Observation

struct PersonalAssistantChatClient {
    var loadStatus: () async throws -> AIAgentConfigStatus
    var send: (AIAgentChatRequest) async throws -> AIAgentChatResult
    var transcribe: (Data) async throws -> AIAgentTranscriptionResult

    static let live = PersonalAssistantChatClient(
        loadStatus: { try await AIAgentService.config() },
        send: { try await AIAgentService.chat($0) },
        transcribe: { try await AIAgentService.transcribe(audioData: $0) }
    )

    #if DEBUG
    static let uiTest = PersonalAssistantChatClient(
        loadStatus: {
            try decode(#"{"configured":true,"credentialStatus":"ready","needsReconnect":false,"businessContext":"Negocio de prueba","webSearchEnabled":true}"#)
        },
        send: { request in
            try await Task.sleep(for: .milliseconds(120))
            let latest = request.messages.last?.content ?? ""
            if latest.localizedCaseInsensitiveContains("agenda") {
                return try decode(#"{"reply":"Ya estoy conectado al mismo asistente. Puedo ayudarte a revisar la agenda y preparar el siguiente paso.","category":"general","sources":[{"title":"Centro de ayuda Ristak","url":"https://www.ristak.com"}],"clarificationOptions":[{"label":"Revisar agenda","value":"agenda","description":"Continuar con citas"},{"label":"Revisar pagos","value":"pagos","description":"Continuar con cobros"}]}"#)
            }
            return try decode(#"{"reply":"Ya estoy conectado al mismo asistente de Ristak. ¿Qué quieres revisar ahora?","category":"general","sources":[{"title":"Centro de ayuda Ristak","url":"https://www.ristak.com"}],"clarificationOptions":[{"label":"Revisar agenda","value":"agenda","description":"Continuar con citas"},{"label":"Revisar pagos","value":"pagos","description":"Continuar con cobros"}]}"#)
        },
        transcribe: { _ in
            try decode(#"{"text":"Revisa mi agenda de hoy","model":"gpt-4o-mini-transcribe"}"#)
        }
    )

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
    #endif
}

struct PersonalAssistantMessage: Identifiable, Equatable, Sendable {
    enum Role: String, Sendable {
        case user
        case assistant
    }

    let id: String
    let role: Role
    let content: String
    let sources: [AIAgentSourceLink]
    let clarificationOptions: [AIAgentClarificationChoice]
    let selectedClarificationOption: AIAgentSelectedClarificationChoicePayload?
    let failed: Bool

    init(
        id: String = UUID().uuidString,
        role: Role,
        content: String,
        sources: [AIAgentSourceLink] = [],
        clarificationOptions: [AIAgentClarificationChoice] = [],
        selectedClarificationOption: AIAgentSelectedClarificationChoicePayload? = nil,
        failed: Bool = false
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.sources = sources
        self.clarificationOptions = clarificationOptions
        self.selectedClarificationOption = selectedClarificationOption
        self.failed = failed
    }
}

enum PersonalAssistantReplyCleaner {
    static func clean(_ rawValue: String, options: [AIAgentClarificationChoice]) -> String {
        let value = stripCitationArtifacts(rawValue)
        guard !options.isEmpty else { return value.trimmingCharacters(in: .whitespacesAndNewlines) }

        let lines = value.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        var output: [String] = []
        var index = 0

        while index < lines.count {
            guard isListLine(lines[index]) else {
                output.append(lines[index])
                index += 1
                continue
            }

            var block: [String] = []
            var mentionsOption = false
            while index < lines.count {
                let line = lines[index]
                if isListLine(line) {
                    block.append(line)
                    mentionsOption = mentionsOption || optionAppears(in: line, options: options)
                    index += 1
                    continue
                }
                if !block.isEmpty,
                   !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   line.first?.isWhitespace == true {
                    block.append(line)
                    index += 1
                    continue
                }
                break
            }

            if mentionsOption {
                removeDanglingOptionsHeading(from: &output)
            } else {
                output.append(contentsOf: block)
            }
        }

        let cleaned = output.joined(separator: "\n")
            .replacingOccurrences(of: #"[ \t]+\n"#, with: "\n", options: .regularExpression)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty { return cleaned }
        return options.count == 1 ? "Selecciona esta opción:" : "Selecciona una opción:"
    }

    private static func stripCitationArtifacts(_ value: String) -> String {
        value
            .replacingOccurrences(of: #"\s*cite[^]*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s*【[^】]*†[^】]*】"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+([.,;:!?])"#, with: "$1", options: .regularExpression)
    }

    private static func isListLine(_ line: String) -> Bool {
        line.range(
            of: #"^\s*(?:[-*•]\s+|\d+[.)]\s+)"#,
            options: .regularExpression
        ) != nil
    }

    private static func optionAppears(
        in line: String,
        options: [AIAgentClarificationChoice]
    ) -> Bool {
        let withoutMarker = line.replacingOccurrences(
            of: #"^\s*(?:[-*•]\s+|\d+[.)]\s+)"#,
            with: "",
            options: .regularExpression
        )
        let normalizedLine = normalize(withoutMarker)
        guard !normalizedLine.isEmpty else { return false }

        return options.contains { option in
            guard let label = option.label else { return false }
            let normalizedLabel = normalize(label)
            guard normalizedLabel.count >= 2 else { return false }
            if normalizedLine.contains(normalizedLabel) { return true }
            let words = normalizedLabel.split(separator: " ").filter { $0.count > 2 }
            guard words.count >= 2 else { return false }
            let matches = words.filter { normalizedLine.contains($0) }.count
            return matches >= 2 && Double(matches) / Double(words.count) >= 0.6
        }
    }

    private static func normalize(_ value: String) -> String {
        let unformatted = value
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[`*_~]"#, with: "", options: .regularExpression)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        let scalars = unformatted.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : " "
        }
        return String(scalars)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
    }

    private static func removeDanglingOptionsHeading(from lines: inout [String]) {
        while lines.last?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true {
            lines.removeLast()
        }
        guard let last = lines.last else { return }
        let normalized = normalize(last.trimmingCharacters(in: CharacterSet(charactersIn: ":")))
        let headings: Set<String> = [
            "opciones", "opciones disponibles", "estas opciones", "elige una opcion",
            "elige una", "selecciona una opcion", "selecciona una",
        ]
        if headings.contains(normalized) { lines.removeLast() }
    }
}

@MainActor
@Observable
final class PersonalAssistantChatViewModel {
    static let intro = "Listo. Soy tu Asistente Personal AI en Ristak. Pregúntame lo que necesites revisar, decidir o preparar dentro del negocio."

    private(set) var messages: [PersonalAssistantMessage] = [
        PersonalAssistantMessage(role: .assistant, content: intro),
    ]
    var draft = ""
    private(set) var status: AIAgentConfigStatus?
    private(set) var isLoadingStatus = false
    private(set) var isSending = false
    private(set) var isTranscribing = false
    private(set) var category = "auto"

    private let client: PersonalAssistantChatClient
    private var didLoadStatus = false

    init(client: PersonalAssistantChatClient = .live) {
        self.client = client
    }

    var headerDetail: String {
        if isTranscribing { return "Interpretando audio…" }
        if isSending { return "Pensando…" }
        if isLoadingStatus { return "Conectando…" }
        if status?.needsReconnect == true { return "Reconecta OpenAI en Ajustes" }
        if status?.configured == false { return "Configura OpenAI para activarlo" }
        return "Pregúntame sobre tu negocio"
    }

    var canSendDraft: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isBusy
    }

    var isBusy: Bool { isSending || isTranscribing }

    func loadStatus() async {
        guard !didLoadStatus else { return }
        didLoadStatus = true
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        do {
            status = try await client.loadStatus()
        } catch {
            // El POST autoritativo sigue siendo el gate. Un GET fallido por red
            // no debe inutilizar el composer ni inventar que OpenAI está apagado.
            status = nil
        }
    }

    func sendDraft() async {
        await send(text: draft)
    }

    func select(_ option: AIAgentClarificationChoice, from assistantMessageID: String) async {
        guard let label = option.label?.trimmingCharacters(in: .whitespacesAndNewlines),
              !label.isEmpty
        else { return }
        let value = option.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedValue = (value?.isEmpty == false ? value : nil) ?? label
        await send(
            text: label,
            selectedOption: AIAgentSelectedClarificationChoicePayload(
                label: label,
                value: resolvedValue,
                description: option.description,
                assistantMessageId: assistantMessageID
            )
        )
    }

    func transcribeAndSend(audioURL: URL) async {
        guard !isBusy else { return }
        isTranscribing = true
        defer {
            isTranscribing = false
            try? FileManager.default.removeItem(at: audioURL)
        }

        do {
            let data = try Data(contentsOf: audioURL)
            let result = try await client.transcribe(data)
            let transcript = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else {
                appendFailure("No detecté texto en la nota de voz. Intenta otra vez.")
                return
            }
            isTranscribing = false
            await send(text: transcript)
        } catch {
            appendFailure("No pude interpretar el audio. \(friendlyMessage(for: error))")
        }
    }

    func resetConversation() {
        guard !isBusy else { return }
        messages = [PersonalAssistantMessage(role: .assistant, content: Self.intro)]
        draft = ""
        category = "auto"
    }

    private func send(
        text rawText: String,
        selectedOption: AIAgentSelectedClarificationChoicePayload? = nil
    ) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isBusy else { return }

        let userMessage = PersonalAssistantMessage(
            role: .user,
            content: text,
            selectedClarificationOption: selectedOption
        )
        messages.append(userMessage)
        draft = ""

        if let status, !status.isReady {
            appendFailure(status.needsReconnect
                ? "OpenAI necesita reconectarse en Ajustes → Asistente Personal AI para que pueda responder."
                : "Primero conecta OpenAI en Ajustes → Asistente Personal AI. Después este chat responderá igual que el asistente de escritorio.")
            return
        }

        isSending = true
        defer { isSending = false }

        do {
            let result = try await client.send(AIAgentChatRequest(
                messages: requestHistory(),
                viewContext: AIAgentViewContextPayload(
                    path: "/ios/chats/ai-agent",
                    title: "Asistente Personal AI",
                    routeLabel: "App iOS · Chats · Asistente Personal AI",
                    visibleText: "El usuario abrió el Asistente Personal AI dentro de Chats en la app nativa de Ristak. Esta conversación no corresponde a un contacto externo y no debe agendar citas ni registrar pagos por sí sola."
                ),
                category: category
            ))

            if let routedCategory = result.category?.trimmingCharacters(in: .whitespacesAndNewlines),
               !routedCategory.isEmpty {
                category = routedCategory
            }
            let reply = PersonalAssistantReplyCleaner.clean(
                result.reply ?? "",
                options: result.clarificationOptions
            )
            messages.append(PersonalAssistantMessage(
                role: .assistant,
                content: reply.isEmpty ? "Listo. ¿Qué más revisamos?" : reply,
                sources: result.sources,
                clarificationOptions: result.clarificationOptions
            ))
        } catch let error as RistakAPIError where error.needsOpenAIReconnect {
            appendFailure("OpenAI necesita reconectarse en Ajustes → Asistente Personal AI.")
        } catch let error as RistakAPIError where error.isOpenAIConfigurationIssue {
            appendFailure("Conecta OpenAI en Ajustes → Asistente Personal AI para usar este chat.")
        } catch {
            appendFailure("No pude responder ahorita. \(friendlyMessage(for: error))")
        }
    }

    private func requestHistory() -> [AIAgentChatMessagePayload] {
        messages.suffix(24).map { message in
            AIAgentChatMessagePayload(
                id: message.id,
                role: message.role.rawValue,
                content: message.content,
                selectedClarificationOption: message.selectedClarificationOption
            )
        }
    }

    private func appendFailure(_ text: String) {
        messages.append(PersonalAssistantMessage(
            role: .assistant,
            content: text,
            failed: true
        ))
    }

    private func friendlyMessage(for error: Error) -> String {
        let message = (error as? LocalizedError)?.errorDescription
            ?? error.localizedDescription
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Revisa tu conexión e inténtalo otra vez." : trimmed
    }
}
