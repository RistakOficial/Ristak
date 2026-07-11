import Foundation
import XCTest
@testable import Ristak

final class ChatMediaUploadTests: XCTestCase {
    func testMultipartCarriesRawBytesWithoutBase64Inflation() throws {
        let bytes = Data(repeating: 0xA5, count: 1_048_576)
        let media = EncodedChatMedia(
            kind: .document,
            binaryData: bytes,
            mimeType: "application/pdf",
            filename: "contrato.pdf",
            sizeBytes: bytes.count,
            durationMs: nil
        )

        let multipart = try ChatMediaMultipartFile(
            media: media,
            clientUploadID: "ios-chat-stable-id",
            contactID: "contact-1"
        )
        defer { multipart.remove() }
        let multipartData = try Data(contentsOf: multipart.url)
        let legacyDataURL = MediaEncoder.dataURL(from: bytes, mimeType: media.mimeType)

        XCTAssertTrue(multipart.contentType.hasPrefix("multipart/form-data; boundary=ristak-ios-"))
        XCTAssertNotNil(multipartData.range(of: Data("name=\"clientUploadId\"".utf8)))
        XCTAssertNotNil(multipartData.range(of: Data("ios-chat-stable-id".utf8)))
        XCTAssertNotNil(multipartData.range(of: Data("filename=\"contrato.pdf\"".utf8)))
        XCTAssertNotNil(multipartData.range(of: bytes))
        XCTAssertNil(multipartData.range(of: Data(";base64,".utf8)))
        XCTAssertNil(multipartData.range(of: Data(bytes.base64EncodedString().utf8)))
        XCTAssertLessThan(multipartData.count, legacyDataURL.utf8.count)
    }

    func testMultipartSanitizesHeaderInjectionWithoutChangingFileContent() throws {
        let bytes = Data([0x00, 0x0D, 0x0A, 0xFF])
        let media = EncodedChatMedia(
            kind: .document,
            binaryData: bytes,
            mimeType: "application/pdf\r\nX-Evil: yes",
            filename: "factura\"\r\nX-Evil: yes.pdf",
            sizeBytes: bytes.count,
            durationMs: nil
        )

        let multipart = try ChatMediaMultipartFile(
            media: media,
            clientUploadID: "upload-1",
            contactID: nil
        )
        defer { multipart.remove() }
        let multipartData = try Data(contentsOf: multipart.url)
        let headerPrefix = String(
            decoding: multipartData.prefix(1_024),
            as: UTF8.self
        )

        XCTAssertFalse(headerPrefix.contains("\r\nX-Evil:"))
        XCTAssertNotNil(multipartData.range(of: bytes))
    }

    func testLegacyFallbackOnlyAppliesToOldEndpointOrOldMediaGate() {
        let notFound = RistakAPIError(
            kind: .notFound,
            status: 404,
            message: "No existe"
        )
        let oldGate = RistakAPIError(
            kind: .featureUnavailable,
            status: 403,
            message: "Gate anterior"
        )
        let offline = RistakAPIError.network(URLError(.notConnectedToInternet))
        let server = RistakAPIError(
            kind: .server,
            status: 503,
            message: "Storage temporalmente no disponible"
        )

        XCTAssertTrue(ChatMediaUploadService.canUseLegacyFallback(notFound))
        XCTAssertTrue(ChatMediaUploadService.canUseLegacyFallback(oldGate))
        XCTAssertFalse(ChatMediaUploadService.canUseLegacyFallback(offline))
        XCTAssertFalse(ChatMediaUploadService.canUseLegacyFallback(server))
    }

    func testOnlyAbsoluteHTTPSAssetIsSafeForExternalProviders() {
        let secure = UploadedChatMedia(
            id: "media-1",
            publicUrl: "https://cdn.example.test/chat/foto.jpg",
            mimeType: "image/jpeg",
            originalFilename: "foto.jpg",
            storedFilename: nil,
            sizeProcessed: 42
        )
        let relative = UploadedChatMedia(
            id: "media-2",
            publicUrl: "/media/assets/media-2/file",
            mimeType: "image/jpeg",
            originalFilename: "foto.jpg",
            storedFilename: nil,
            sizeProcessed: 42
        )
        let insecure = UploadedChatMedia(
            id: "media-3",
            publicUrl: "http://localhost/media-3",
            mimeType: "image/jpeg",
            originalFilename: "foto.jpg",
            storedFilename: nil,
            sizeProcessed: 42
        )

        XCTAssertTrue(secure.hasPublicHTTPSURL)
        XCTAssertFalse(relative.hasPublicHTTPSURL)
        XCTAssertFalse(insecure.hasPublicHTTPSURL)
    }

    func testUploadedReferenceCarriesServerAssetID() {
        let asset = UploadedChatMedia(
            id: "media-tenant-123",
            publicUrl: "https://cdn.example.test/chat/foto.jpg",
            mimeType: "image/jpeg",
            originalFilename: "foto.jpg",
            storedFilename: nil,
            sizeProcessed: 42
        )

        let reference = ChatMediaSendReference.uploaded(asset)

        XCTAssertEqual(reference.mediaAssetID, "media-tenant-123")
        XCTAssertEqual(reference.publicURL, asset.publicUrl)
        XCTAssertNil(reference.legacyDataURL)
    }

    func testMessagePayloadEncodesTypedMediaAssetID() throws {
        let request = ImageMessageSendRequest(
            to: "+5215555555555",
            imageUrl: "https://cdn.example.test/chat/foto.jpg",
            imageMediaAssetId: "media-tenant-123"
        )
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )

        XCTAssertEqual(json["imageMediaAssetId"] as? String, "media-tenant-123")
    }

    func testRemoteEchoReleasesLargeOptimisticImagePreview() {
        let optimistic = ChatAttachment(
            type: .image,
            localPreviewData: Data(repeating: 0xA5, count: 2 * 1_024 * 1_024),
            name: "foto.jpg",
            mimeType: "image/jpeg"
        )
        let server = ChatAttachment(
            type: .image,
            url: "https://cdn.example.test/chat/foto.jpg"
        )

        let reconciled = ConversationViewModel.reconciledAttachment(
            server: server,
            optimistic: optimistic
        )

        XCTAssertNil(reconciled?.localPreviewData)
        XCTAssertEqual(reconciled?.url, server.url)
        XCTAssertEqual(reconciled?.name, optimistic.name)
    }

    func testOptimisticPreviewSurvivesUntilRemoteSourceExists() {
        let preview = Data([0x01, 0x02, 0x03])
        let optimistic = ChatAttachment(type: .image, localPreviewData: preview)
        let server = ChatAttachment(type: .image)

        let reconciled = ConversationViewModel.reconciledAttachment(
            server: server,
            optimistic: optimistic
        )

        XCTAssertEqual(reconciled?.localPreviewData, preview)
    }

    func testLegacyDataURLKeepsBinaryPreviewWithoutDuplicateBase64Copy() {
        let preview = Data([0x01, 0x02, 0x03])
        let optimistic = ChatAttachment(type: .image, localPreviewData: preview)
        let server = ChatAttachment(
            type: .image,
            dataUrl: "data:image/jpeg;base64,AQID"
        )

        let reconciled = ConversationViewModel.reconciledAttachment(
            server: server,
            optimistic: optimistic
        )

        XCTAssertEqual(reconciled?.localPreviewData, preview)
        XCTAssertNil(reconciled?.dataUrl)
    }

    func testLegacyDataURLInURLFieldKeepsPreviewAndIsStripped() {
        let preview = Data([0x01, 0x02, 0x03])
        let reconciled = ConversationViewModel.reconciledAttachment(
            server: ChatAttachment(type: .image, url: "data:image/jpeg;base64,AQID"),
            optimistic: ChatAttachment(type: .image, localPreviewData: preview)
        )

        XCTAssertEqual(reconciled?.localPreviewData, preview)
        XCTAssertNil(reconciled?.url)
    }

    func testRemoteURLDropsParallelLegacyBase64Copy() {
        let reconciled = ConversationViewModel.reconciledAttachment(
            server: ChatAttachment(
                type: .image,
                url: "https://cdn.example.test/foto.jpg",
                dataUrl: "data:image/jpeg;base64,AQID"
            ),
            optimistic: ChatAttachment(type: .image, localPreviewData: Data([0x01]))
        )

        XCTAssertNil(reconciled?.localPreviewData)
        XCTAssertNil(reconciled?.dataUrl)
    }

    func testThreadSnapshotNeverPersistsBase64DataURL() {
        XCTAssertNil(ChatThreadSnapshotCache.persistableDataURL(
            "data:image/jpeg;base64,AQID"
        ))
        XCTAssertNil(ChatThreadSnapshotCache.persistableMediaURL(
            "data:image/jpeg;base64,AQID"
        ))
        XCTAssertEqual(
            ChatThreadSnapshotCache.persistableDataURL("https://cdn.example.test/foto.jpg"),
            "https://cdn.example.test/foto.jpg"
        )
    }

    func testSyntheticNetworkBarrierBlocksRequestsBeforeTransport() async throws {
        let previous = ProcessInfo.processInfo.environment["RISTAK_NETWORK_ACCESS"]
        setenv("RISTAK_NETWORK_ACCESS", "disabled", 1)
        defer {
            if let previous {
                setenv("RISTAK_NETWORK_ACCESS", previous, 1)
            } else {
                unsetenv("RISTAK_NETWORK_ACCESS")
            }
        }

        let client = APIClient()
        await client.configure(
            baseURL: URL(string: "https://network-must-not-run.invalid"),
            token: "test-token"
        )
        do {
            let _: Data = try await client.rawData("/health")
            XCTFail("El harness sintético no debe abrir red.")
        } catch let error as RistakAPIError {
            XCTAssertEqual(error.kind, .network)
        }
    }
}
