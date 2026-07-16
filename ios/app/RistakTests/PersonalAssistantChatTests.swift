import XCTest
@testable import Ristak

private actor PersonalAssistantRequestRecorder {
    private(set) var requests: [AIAgentChatRequest] = []

    func append(_ request: AIAgentChatRequest) {
        requests.append(request)
    }

    func snapshot() -> [AIAgentChatRequest] {
        requests
    }
}

final class PersonalAssistantChatTests: XCTestCase {
    func testReplyCleanerRemovesCitationArtifactsAndDuplicatedOptions() throws {
        let options: [AIAgentClarificationChoice] = try Self.decode("""
        [
          {"label":"Revisar agenda","value":"agenda"},
          {"label":"Revisar pagos","value":"pagos"}
        ]
        """)

        let cleaned = PersonalAssistantReplyCleaner.clean(
            """
            Ya revisé el negocio. citeturn0search0

            Opciones:
            1. Revisar agenda
            2. Revisar pagos
            """,
            options: options
        )

        XCTAssertEqual(cleaned, "Ya revisé el negocio.")
    }

    @MainActor
    func testSendUsesDesktopContractAndKeepsRoutedCategory() async throws {
        let recorder = PersonalAssistantRequestRecorder()
        let client = PersonalAssistantChatClient(
            loadStatus: { try Self.readyStatus() },
            send: { request in
                await recorder.append(request)
                return try Self.chatResult(
                    reply: "Tu agenda está lista.",
                    category: "calendar",
                    includesOptions: true
                )
            },
            transcribe: { _ in try Self.transcription() }
        )
        let viewModel = PersonalAssistantChatViewModel(client: client)

        await viewModel.loadStatus()
        viewModel.draft = "Revisa mi agenda"
        await viewModel.sendDraft()

        XCTAssertEqual(viewModel.category, "calendar")
        XCTAssertEqual(viewModel.messages.suffix(2).map(\.role), [.user, .assistant])
        XCTAssertEqual(viewModel.messages.last?.content, "Tu agenda está lista.")
        XCTAssertEqual(viewModel.messages.last?.sources.count, 1)
        XCTAssertEqual(viewModel.messages.last?.clarificationOptions.count, 1)

        let firstRequests = await recorder.snapshot()
        let firstRequest = try XCTUnwrap(firstRequests.first)
        XCTAssertEqual(firstRequest.category, "auto")
        XCTAssertEqual(firstRequest.viewContext.path, "/ios/chats/ai-agent")
        XCTAssertEqual(firstRequest.messages.last?.content, "Revisa mi agenda")

        let assistantMessageID = try XCTUnwrap(viewModel.messages.last?.id)
        let option = try XCTUnwrap(viewModel.messages.last?.clarificationOptions.first)
        await viewModel.select(option, from: assistantMessageID)

        let requests = await recorder.snapshot()
        let continuation = try XCTUnwrap(requests.last)
        XCTAssertEqual(continuation.category, "calendar")
        XCTAssertEqual(continuation.messages.last?.content, "Continuar con agenda")
        XCTAssertEqual(continuation.messages.last?.selectedClarificationOption?.value, "calendar_next")
        XCTAssertEqual(
            continuation.messages.last?.selectedClarificationOption?.assistantMessageId,
            assistantMessageID
        )
    }

    @MainActor
    func testMissingOpenAIConfigurationExplainsNextStepWithoutCallingChat() async throws {
        let recorder = PersonalAssistantRequestRecorder()
        let client = PersonalAssistantChatClient(
            loadStatus: { try Self.missingStatus() },
            send: { request in
                await recorder.append(request)
                return try Self.chatResult(reply: "No debe ejecutarse", category: "general")
            },
            transcribe: { _ in try Self.transcription() }
        )
        let viewModel = PersonalAssistantChatViewModel(client: client)

        await viewModel.loadStatus()
        viewModel.draft = "Hola"
        await viewModel.sendDraft()

        let requests = await recorder.snapshot()
        XCTAssertTrue(requests.isEmpty)
        XCTAssertEqual(viewModel.messages.count, 3)
        XCTAssertTrue(viewModel.messages.last?.failed == true)
        XCTAssertTrue(viewModel.messages.last?.content.contains("conecta OpenAI") == true)
    }

    private static func readyStatus() throws -> AIAgentConfigStatus {
        try decode(#"{"configured":true,"credentialStatus":"ready","needsReconnect":false,"businessContext":"Ristak","webSearchEnabled":true}"#)
    }

    private static func missingStatus() throws -> AIAgentConfigStatus {
        try decode(#"{"configured":false,"credentialStatus":"missing","needsReconnect":false,"businessContext":"","webSearchEnabled":false}"#)
    }

    private static func transcription() throws -> AIAgentTranscriptionResult {
        try decode(#"{"text":"Revisa mi agenda","model":"gpt-4o-mini-transcribe"}"#)
    }

    private static func chatResult(
        reply: String,
        category: String,
        includesOptions: Bool = false
    ) throws -> AIAgentChatResult {
        let options = includesOptions
            ? #", "clarificationOptions":[{"label":"Continuar con agenda","value":"calendar_next","description":"Revisar la siguiente cita"}]"#
            : ""
        let json = """
        {
          "reply": \(try jsonString(reply)),
          "category": \(try jsonString(category)),
          "sources": [{"title":"Ayuda","url":"https://www.ristak.com"}]
          \(options)
        }
        """
        return try decode(json)
    }

    private static func jsonString(_ value: String) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [value])
        let encoded = try XCTUnwrap(String(data: data, encoding: .utf8))
        return String(encoded.dropFirst().dropLast())
    }

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
