import XCTest
@testable import Ristak

final class ConversationChannelRoutingTests: XCTestCase {
    func testSelectorShowsNativeMetaHighLevelWhatsAppAndEverySMSSenderTogether() throws {
        let status = try whatsAppStatus()
        let highLevelPhones = try JSONDecoder().decode(
            [HighLevelPhoneNumber].self,
            from: Data(
                """
                [
                  {"id":"ghl-1","phoneNumber":"+15550001111","label":"Ventas","isDefault":true},
                  {"id":"ghl-2","phoneNumber":"+15550002222","label":"Soporte","isDefault":false}
                ]
                """.utf8
            )
        )

        let options = ConversationChannelOptionsBuilder.build(
            whatsAppStatus: status,
            highLevelConnected: true,
            highLevelWhatsAppFromNumber: "+15559990000",
            highLevelPhoneNumbers: highLevelPhones,
            hasContactPhone: true,
            channelEvidence: "api ghl_whatsapp"
        )

        XCTAssertNil(options.first(where: { $0.channel == .whatsapp(phoneNumberId: "meta-direct") })?.disabledReason)
        XCTAssertNil(options.first(where: {
            $0.channel == .highLevelWhatsApp(fromNumber: "+15559990000")
        })?.disabledReason)
        XCTAssertNil(options.first(where: { $0.channel == .sms(fromNumber: "+15550001111") })?.disabledReason)
        XCTAssertNil(options.first(where: { $0.channel == .sms(fromNumber: "+15550002222") })?.disabledReason)
    }

    func testRouteMatchesDesktopPriorityUsingLastInboundBeforeLastBusinessAndDefault() throws {
        let phones = try whatsAppStatus().phoneNumbers

        let byInboundID = ConversationWhatsAppRouteResolver.resolvePhone(
            from: phones,
            preferredPhoneNumberID: "missing-preference",
            lastInboundBusinessPhoneNumberID: "meta-direct",
            lastInboundBusinessPhone: nil,
            lastBusinessPhoneNumberID: "ycloud-default",
            lastBusinessPhone: "+15550003333"
        )
        XCTAssertEqual(byInboundID?.id, "meta-direct")

        let byInboundFormattedPhone = ConversationWhatsAppRouteResolver.resolvePhone(
            from: phones,
            preferredPhoneNumberID: nil,
            lastInboundBusinessPhoneNumberID: nil,
            lastInboundBusinessPhone: "(656) 861-9478",
            lastBusinessPhoneNumberID: "ycloud-default",
            lastBusinessPhone: "+15550003333"
        )
        XCTAssertEqual(byInboundFormattedPhone?.id, "meta-direct")
    }

    func testLatestDirectMetaEvidenceDoesNotFallBackToOldHighLevelHistory() throws {
        let phones = try whatsAppStatus().phoneNumbers

        let native = ConversationWhatsAppRouteResolver.defaultChannel(
            latestChannelEvidence: "api api",
            highLevelConnected: true,
            highLevelWhatsAppFromNumber: "+15559990000",
            highLevelPhoneNumbers: [],
            whatsAppPhones: phones,
            preferredPhoneNumberID: nil,
            lastInboundBusinessPhoneNumberID: "meta-direct",
            lastInboundBusinessPhone: "+526568619478",
            lastBusinessPhoneNumberID: nil,
            lastBusinessPhone: nil
        )
        XCTAssertEqual(native, .whatsapp(phoneNumberId: "meta-direct"))

        let highLevel = ConversationWhatsAppRouteResolver.defaultChannel(
            latestChannelEvidence: "whatsapp ghl_whatsapp",
            highLevelConnected: true,
            highLevelWhatsAppFromNumber: "+15559990000",
            highLevelPhoneNumbers: [],
            whatsAppPhones: phones,
            preferredPhoneNumberID: nil,
            lastInboundBusinessPhoneNumberID: "meta-direct",
            lastInboundBusinessPhone: "+526568619478",
            lastBusinessPhoneNumberID: nil,
            lastBusinessPhone: nil
        )
        XCTAssertEqual(highLevel, .highLevelWhatsApp(fromNumber: "+15559990000"))
    }

    func testHighLevelWhatsAppUsesNewestInboundGHLBusinessPhoneOnly() {
        let messages = [
            message(id: "old-ghl", date: "2026-07-15T15:00:00Z", channel: "whatsapp", transport: "ghl_whatsapp", businessPhone: "+15550001111"),
            message(id: "native-newer", date: "2026-07-15T17:30:00Z", channel: "api", transport: "api", businessPhone: "+15550009999"),
            message(id: "sms-newer", date: "2026-07-15T17:40:00Z", channel: "ghl_sms", transport: "ghl_sms", businessPhone: "+15550008888"),
            message(id: "outbound-ghl", date: "2026-07-15T17:50:00Z", direction: .outbound, channel: "ghl_whatsapp", transport: "ghl_whatsapp", businessPhone: "+15550007777"),
            message(id: "new-ghl", date: "2026-07-15T17:00:00Z", channel: "ghl_whatsapp", transport: "whatsapp_api", businessPhone: "+15550002222"),
            message(id: "ghl-without-phone", date: "2026-07-15T17:55:00Z", channel: "ghl_whatsapp", transport: "ghl_whatsapp"),
        ]

        XCTAssertEqual(
            ConversationHighLevelWhatsAppRouteResolver.latestInboundBusinessPhone(in: messages),
            "+15550002222"
        )
    }

    func testHighLevelWhatsAppOptionFailsClosedWithoutVerifiedInboundSender() throws {
        let options = ConversationChannelOptionsBuilder.build(
            whatsAppStatus: try whatsAppStatus(),
            highLevelConnected: true,
            highLevelWhatsAppFromNumber: nil,
            highLevelPhoneNumbers: [],
            hasContactPhone: true,
            channelEvidence: "ghl_whatsapp"
        )
        let option = try XCTUnwrap(options.first(where: {
            if case .highLevelWhatsApp = $0.channel { return true }
            return false
        }))

        XCTAssertEqual(option.channel, .highLevelWhatsApp(fromNumber: ""))
        XCTAssertNotNil(option.disabledReason)
        XCTAssertTrue(option.subtitle.localizedCaseInsensitiveContains("Recibe primero"))
    }

    func testRecoverableInitialFailureKeepsPendingSSEAndDrainsWhenRecoveryStarts() {
        var gate = ConversationRealtimeBootstrapGate()
        gate.beginInitialAttempt()

        XCTAssertFalse(gate.receiveVisibleThreadEvent())
        XCTAssertFalse(gate.receiveVisibleThreadEvent())
        XCTAssertTrue(gate.hasPendingRefresh)

        // El primer GET falló por red, pero eso termina el intento y permite
        // que el refresh pendiente haga la recuperación silenciosa.
        XCTAssertTrue(gate.finishInitialAttempt(allowsSilentRecovery: true))
        XCTAssertTrue(gate.initialAttemptFinished)
        XCTAssertFalse(gate.hasPendingRefresh)
        XCTAssertFalse(gate.finishInitialAttempt(allowsSilentRecovery: true))
        XCTAssertTrue(gate.receiveVisibleThreadEvent())
    }

    func testTerminalBootstrapFailureDoesNotResurrectCancelledOrDeniedThread() {
        var gate = ConversationRealtimeBootstrapGate()
        gate.beginInitialAttempt()
        XCTAssertFalse(gate.receiveVisibleThreadEvent())

        XCTAssertFalse(gate.finishInitialAttempt(allowsSilentRecovery: false))
        XCTAssertFalse(gate.initialAttemptFinished)
        XCTAssertTrue(gate.hasPendingRefresh)
        XCTAssertFalse(gate.receiveVisibleThreadEvent())
    }

    func testRealtimeConnectionDisablesThreadPollingUntilDisconnected() {
        var policy = ConversationRealtimePollingPolicy()

        XCTAssertTrue(policy.shouldScheduleFallback)
        XCTAssertEqual(
            ConversationRealtimePollingPolicy.fallbackInterval,
            PollingClock.Cadence.threadFallback
        )
        XCTAssertTrue((20.0...30.0).contains(ConversationRealtimePollingPolicy.fallbackInterval))

        XCTAssertEqual(policy.setConnected(true), .initial)
        XCTAssertTrue(policy.isConnected)
        XCTAssertFalse(policy.shouldScheduleFallback)

        XCTAssertEqual(policy.setConnected(false), .disconnected)
        XCTAssertFalse(policy.isConnected)
        XCTAssertTrue(policy.shouldScheduleFallback)
    }

    func testInitialConnectionDoesNotDuplicateBootstrapButRealReconnectClosesGap() {
        var policy = ConversationRealtimePollingPolicy()

        let initial = policy.setConnected(true)
        XCTAssertEqual(initial, .initial)
        XCTAssertFalse(ConversationRealtimeRefreshDecision.shouldReconcile(
            transition: initial,
            initialAttemptFinished: false
        ))
        // Si el primer enlace llega DESPUÉS del bootstrap, sí cierra el hueco.
        XCTAssertTrue(ConversationRealtimeRefreshDecision.shouldReconcile(
            transition: initial,
            initialAttemptFinished: true
        ))
        XCTAssertEqual(policy.setConnected(true), .none)

        let disconnected = policy.setConnected(false)
        XCTAssertEqual(disconnected, .disconnected)
        XCTAssertFalse(ConversationRealtimeRefreshDecision.shouldReconcile(
            transition: disconnected,
            initialAttemptFinished: true
        ))
        XCTAssertEqual(policy.setConnected(false), .none)

        // Al recuperar un stream sin replay se pide exactamente una descarga.
        let reconnected = policy.setConnected(true)
        XCTAssertEqual(reconnected, .reconnected)
        XCTAssertTrue(ConversationRealtimeRefreshDecision.shouldReconcile(
            transition: reconnected,
            initialAttemptFinished: true
        ))
        XCTAssertEqual(policy.setConnected(true), .none)
    }

    func testInboxUsesFallbackOnlyDisconnectedAndTwoMinuteReconciliationConnected() {
        var policy = InboxRealtimePollingPolicy()

        XCTAssertFalse(policy.isConnected)
        XCTAssertEqual(
            policy.reconciliationInterval,
            PollingClock.Cadence.inboxFallback
        )
        XCTAssertTrue((20.0...30.0).contains(policy.reconciliationInterval))

        XCTAssertTrue(policy.setConnected(true))
        XCTAssertTrue(policy.isConnected)
        XCTAssertEqual(
            policy.reconciliationInterval,
            PollingClock.Cadence.inboxConnectedReconciliation
        )
        XCTAssertEqual(policy.reconciliationInterval, 120)

        // Un frame repetido no debe reprogramar un ticker nuevo ni aplazar el
        // que ya corre; el ViewModel solo reconcilia cuando esto devuelve true.
        XCTAssertFalse(policy.setConnected(true))
        XCTAssertTrue(policy.setConnected(false))
        XCTAssertEqual(
            policy.reconciliationInterval,
            PollingClock.Cadence.inboxFallback
        )
    }

    func testRefreshBurstPreservesDirtyFollowUpAsOneCoalescedTrailingRefresh() {
        var gate = ChatRefreshBurstGate()

        XCTAssertTrue(gate.beginOrQueue())
        XCTAssertEqual(gate.phase, .primary)
        XCTAssertFalse(gate.beginOrQueue())
        XCTAssertTrue(gate.hasPendingFollowUp)
        XCTAssertTrue(gate.consumeFollowUp())
        XCTAssertEqual(gate.phase, .followUp)

        // Cien eventos durante el follow-up/cooldown producen UN trailing, no
        // cien GETs ni una pérdida silenciosa del último mensaje.
        XCTAssertFalse(gate.beginOrQueue())
        XCTAssertFalse(gate.consumeFollowUp())
        XCTAssertTrue(gate.finishBurst())
        XCTAssertTrue(gate.isCoolingDown)
        for _ in 0..<100 {
            XCTAssertFalse(gate.beginOrQueue())
        }

        XCTAssertTrue(gate.beginTrailingRefresh())
        XCTAssertEqual(gate.phase, .primary)
        XCTAssertFalse(gate.finishBurst())
        XCTAssertEqual(gate.phase, .idle)

        XCTAssertFalse(gate.isInFlight)
        XCTAssertFalse(gate.hasPendingFollowUp)
        XCTAssertTrue(gate.beginOrQueue())
    }

    func testRefreshBurstCooldownCanBeCancelledWithoutReleasingInFlightRequest() {
        var gate = ChatRefreshBurstGate()
        XCTAssertTrue(gate.beginOrQueue())
        XCTAssertFalse(gate.beginOrQueue())
        XCTAssertTrue(gate.consumeFollowUp())
        XCTAssertFalse(gate.beginOrQueue())
        XCTAssertTrue(gate.finishBurst())

        gate.cancelCooldown()
        XCTAssertEqual(gate.phase, .idle)
        XCTAssertTrue(gate.beginOrQueue())
        gate.cancelCooldown()
        XCTAssertEqual(gate.phase, .primary, "cancelCooldown no libera un GET en vuelo")
    }

    @MainActor
    func testFallbackScheduledWhilePausedFiresExactlyOnceWhenClockResumes() async {
        let clock = PollingClock()
        var fireCount = 0
        clock.setPaused(true)
        clock.schedule("foreground-fallback", every: 60) {
            fireCount += 1
        }

        clock.setPaused(false)
        for _ in 0..<10 where fireCount == 0 {
            await Task.yield()
        }
        XCTAssertEqual(fireCount, 1)
        clock.cancelAll()
    }

    func testChatStreamMapsInternalDisconnectToFallbackSignal() {
        let event = ChatRealtimeEvent(frame: RistakServerSentEvent(
            name: RistakSSEInternalEvent.disconnected,
            data: ""
        ))

        guard case .disconnected? = event else {
            return XCTFail("El cierre del socket debe activar el fallback del hilo")
        }
    }

    func testLocalCatalogRetryRunsAtMostTwice() async throws {
        enum StubError: Error { case unavailable }
        var attempts = 0

        let result: Int = try await ConversationLocalCatalogRetry.load(retryDelayNanoseconds: 0) {
            attempts += 1
            if attempts == 1 { throw StubError.unavailable }
            return 42
        }

        XCTAssertEqual(result, 42)
        XCTAssertEqual(attempts, 2)

        attempts = 0
        do {
            let _: Int = try await ConversationLocalCatalogRetry.load(retryDelayNanoseconds: 0) {
                attempts += 1
                throw StubError.unavailable
            }
            XCTFail("El segundo fallo debía propagarse")
        } catch StubError.unavailable {
            XCTAssertEqual(attempts, 2)
        }
    }

    func testHighLevelRequiresConfirmedConnectionNotOnlyConfiguredRow() throws {
        let cases: [(String, Bool)] = [
            (#"{"highlevel":{"configured":true,"connected":false}}"#, false),
            (#"{"highlevel":{"configured":false,"connected":true}}"#, true),
            (#"{"highlevel":{"configured":true,"connected":true}}"#, true),
            (#"{"highlevel":{"configured":"1","connected":"0"}}"#, false),
            (#"{"highlevel":{"configured":"0","connected":"1"}}"#, true),
            (#"{}"#, false),
        ]

        for (json, expected) in cases {
            let status = try JSONDecoder().decode(IntegrationsStatus.self, from: Data(json.utf8))
            XCTAssertEqual(status.isHighLevelConnected, expected, json)
        }
    }

    func testSendResultClassifiesProviderFailurePendingAndSettledStatuses() {
        for status in ["failed", "ERROR", "undelivered", "rejected", "bounced", "failure"] {
            let disposition = ChatSendDeliveryDisposition.resolve(status: status)
            XCTAssertEqual(disposition, .failed, status)
            XCTAssertTrue(disposition.shouldRetainRetryPayload, status)
        }

        for status in ["pending", "queued", "sending", "processing", "accepted", "Enviando por API"] {
            let disposition = ChatSendDeliveryDisposition.resolve(status: status)
            XCTAssertEqual(disposition, .pending, status)
            XCTAssertTrue(disposition.shouldRetainRetryPayload, status)
        }

        for status in [nil, "sent", "delivered", "read", "success"] as [String?] {
            let disposition = ChatSendDeliveryDisposition.resolve(status: status)
            XCTAssertEqual(disposition, .settled, status ?? "nil")
            XCTAssertFalse(disposition.shouldRetainRetryPayload, status ?? "nil")
        }
    }

    func testHighLevelSendResultKeepsMessageIdAndSemanticFailure() throws {
        let result = try JSONDecoder().decode(
            MessageSendResult.self,
            from: Data(
                """
                {
                  "status":"failed",
                  "messageId":"ghl-123",
                  "localMessageId":"local-1",
                  "transport":"ghl_whatsapp"
                }
                """.utf8
            )
        )

        XCTAssertEqual(result.deliveryDisposition, .failed)
        XCTAssertEqual(result.resolvedProviderMessageId, "ghl-123")
        XCTAssertEqual(result.localMessageId, "local-1")
        XCTAssertEqual(result.transport, "ghl_whatsapp")
    }

    func testProviderAcknowledgedFailureReconcilesOnlyByExactIdentity() {
        let optimistic = message(
            id: "optimistic-1",
            date: "2026-07-15T17:00:00Z",
            direction: .outbound,
            text: "Hola",
            channel: "ghl_whatsapp",
            transport: "ghl_whatsapp",
            providerMessageId: "ghl-123",
            failed: true
        )
        let durable = message(
            id: "local-1",
            date: "2026-07-15T17:00:01Z",
            direction: .outbound,
            text: "Hola",
            channel: "ghl_whatsapp",
            transport: "ghl_whatsapp",
            providerMessageId: "ghl-123"
        )

        XCTAssertTrue(ConversationOptimisticReconciliationPolicy.canMatch(
            optimistic: optimistic,
            isInFlight: false,
            providerAcknowledgedFailure: true,
            authoritativeServerMessageID: "local-1"
        ))
        XCTAssertTrue(ConversationOptimisticReconciliationPolicy.identitiesMatch(
            optimisticProviderMessageID: optimistic.providerMessageId,
            authoritativeServerMessageID: "local-1",
            server: durable
        ))

        var unrelated = durable
        unrelated.id = "local-2"
        unrelated.providerMessageId = "ghl-999"
        XCTAssertFalse(ConversationOptimisticReconciliationPolicy.identitiesMatch(
            optimisticProviderMessageID: optimistic.providerMessageId,
            authoritativeServerMessageID: "local-1",
            server: unrelated
        ))

        XCTAssertFalse(ConversationOptimisticReconciliationPolicy.canMatch(
            optimistic: optimistic,
            isInFlight: false,
            providerAcknowledgedFailure: false,
            authoritativeServerMessageID: nil
        ))
    }

    func testNativeReplyWindowIsScopedToSelectedSenderAndExact24HoursCloses() throws {
        let phones = try whatsAppStatus().phoneNumbers
        let meta = try XCTUnwrap(phones.first(where: { $0.id == "meta-direct" }))
        let ycloud = try XCTUnwrap(phones.first(where: { $0.id == "ycloud-default" }))
        let now = try XCTUnwrap(RistakDateParsing.date(fromISO: "2026-07-15T18:00:00Z"))
        let metaInbound = message(
            id: "meta-recent",
            date: "2026-07-15T17:00:00Z",
            businessPhone: "+526568619478",
            businessPhoneNumberId: "meta-direct"
        )
        let oldYCloudInbound = message(
            id: "ycloud-old",
            date: "2026-07-14T18:00:00Z",
            businessPhone: "+15550003333",
            businessPhoneNumberId: "ycloud-default"
        )
        let messages = [oldYCloudInbound, metaInbound]

        let metaDate = ConversationWhatsAppReplyWindowResolver.lastInboundDate(
            in: messages,
            selectedPhone: meta
        )
        let ycloudDate = ConversationWhatsAppReplyWindowResolver.lastInboundDate(
            in: messages,
            selectedPhone: ycloud
        )

        XCTAssertTrue(WhatsAppReplyWindowRules.isWindowOpen(lastInboundDate: metaDate, now: now))
        XCTAssertFalse(WhatsAppReplyWindowRules.isWindowOpen(lastInboundDate: ycloudDate, now: now))
    }

    func testNativeReplyWindowMatchesFormattedPhoneButFailsClosedWithoutSenderIdentity() throws {
        let meta = try XCTUnwrap(try whatsAppStatus().phoneNumbers.first(where: { $0.id == "meta-direct" }))
        let formatted = message(
            id: "formatted",
            date: "2026-07-15T17:00:00Z",
            businessPhone: "(656) 861-9478"
        )
        let legacy = message(id: "legacy", date: "2026-07-15T17:30:00Z")

        XCTAssertEqual(
            ConversationWhatsAppReplyWindowResolver.lastInboundDate(
                in: [formatted],
                selectedPhone: meta
            ),
            formatted.parsedDate
        )
        XCTAssertNil(ConversationWhatsAppReplyWindowResolver.lastInboundDate(
            in: [legacy],
            selectedPhone: meta
        ))
    }

    func testNativeReplyWindowExcludesHighLevelSocialEmailOutboundAndComments() throws {
        let meta = try XCTUnwrap(try whatsAppStatus().phoneNumbers.first(where: { $0.id == "meta-direct" }))
        let identity = (phone: "+526568619478", id: "meta-direct")
        let excluded = [
            message(id: "ghl", date: "2026-07-15T17:00:00Z", channel: "ghl_whatsapp", transport: "ghl_whatsapp", businessPhone: identity.phone, businessPhoneNumberId: identity.id),
            message(id: "messenger", date: "2026-07-15T17:01:00Z", channel: "messenger", transport: "messenger", businessPhone: identity.phone, businessPhoneNumberId: identity.id),
            message(id: "instagram", date: "2026-07-15T17:02:00Z", channel: "instagram", transport: "instagram", businessPhone: identity.phone, businessPhoneNumberId: identity.id),
            message(id: "email", date: "2026-07-15T17:03:00Z", channel: "email", transport: "email", businessPhone: identity.phone, businessPhoneNumberId: identity.id),
            message(id: "outbound", date: "2026-07-15T17:04:00Z", direction: .outbound, businessPhone: identity.phone, businessPhoneNumberId: identity.id),
            message(id: "comment", date: "2026-07-15T17:05:00Z", businessPhone: identity.phone, businessPhoneNumberId: identity.id, isComment: true),
        ]

        XCTAssertNil(ConversationWhatsAppReplyWindowResolver.lastInboundDate(
            in: excluded,
            selectedPhone: meta
        ))
    }

    private func whatsAppStatus() throws -> WhatsAppAPIStatus {
        try JSONDecoder().decode(
            WhatsAppAPIStatus.self,
            from: Data(
                """
                {
                  "provider":"ycloud",
                  "activeProvider":"meta_direct",
                  "connected":false,
                  "configured":false,
                  "status":"disconnected",
                  "needsDefaultSelection":false,
                  "phoneNumbers":[
                    {
                      "id":"meta-direct",
                      "provider":"meta_direct",
                      "phone_number":"+526568619478",
                      "display_phone_number":"+52 1 656 861 9478",
                      "verified_name":"Meta directo",
                      "status":"CONNECTED",
                      "api_send_enabled":true,
                      "qr_send_enabled":false,
                      "is_default_sender":false,
                      "availability":{"apiAvailable":true,"apiReason":"","qrReady":false,"available":true}
                    },
                    {
                      "id":"ycloud-default",
                      "provider":"ycloud",
                      "phone_number":"+15550003333",
                      "display_phone_number":"+1 555 000 3333",
                      "verified_name":"YCloud",
                      "status":"CONNECTED",
                      "api_send_enabled":true,
                      "qr_send_enabled":false,
                      "is_default_sender":true,
                      "availability":{"apiAvailable":true,"apiReason":"","qrReady":false,"available":true}
                    }
                  ]
                }
                """.utf8
            )
        )
    }

    private func message(
        id: String,
        date: String,
        direction: ChatMessageDirection = .inbound,
        text: String = "Hola",
        channel: String = "api",
        transport: String = "api",
        providerMessageId: String? = nil,
        businessPhone: String? = nil,
        businessPhoneNumberId: String? = nil,
        isComment: Bool = false,
        failed: Bool = false
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            contactId: "contact-1",
            date: date,
            direction: direction,
            text: text,
            channel: channel,
            status: failed ? "failed" : nil,
            transport: transport,
            providerMessageId: providerMessageId,
            businessPhone: businessPhone,
            businessPhoneNumberId: businessPhoneNumberId,
            isComment: isComment,
            failed: failed
        )
    }
}
