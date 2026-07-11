import XCTest

@MainActor
final class RistakUITests: XCTestCase {
    private var launchedApp: XCUIApplication?

    override func tearDown() {
        launchedApp?.terminate()
        launchedApp = nil
        super.tearDown()
    }

    func testSyntheticAppLaunchesWithoutNetwork() {
        let app = launchSyntheticApp(chatCount: 5_000)

        XCTAssertTrue(
            element(in: app, identifier: "synthetic-root").waitForExistence(timeout: 8),
            "El modo sintético debe quedar utilizable sin sesión ni red."
        )
        XCTAssertTrue(element(in: app, identifier: "synthetic-chat-list").exists)
        XCTAssertTrue(element(in: app, identifier: "synthetic-chat-count").exists)
    }

    func testSearchOpensHistoryAndAppointment() {
        let app = launchSyntheticApp(chatCount: 10_000)
        let search = app.textFields["synthetic-search"]

        XCTAssertTrue(search.waitForExistence(timeout: 8))
        focusAndType("10000", into: search, app: app)

        let lastRow = element(in: app, identifier: "synthetic-chat-row-9999")
        XCTAssertTrue(
            lastRow.waitForExistence(timeout: 2),
            "La búsqueda debe encontrar de inmediato un contacto al final de 10k filas."
        )
        dismissKeyboard(in: app)
        lastRow.tap()

        XCTAssertTrue(
            element(in: app, identifier: "synthetic-history").waitForExistence(timeout: 2),
            "El historial debe abrir sin esperar una respuesta de red."
        )

        let schedule = app.buttons["synthetic-schedule"]
        XCTAssertTrue(schedule.exists)
        schedule.tap()
        XCTAssertTrue(
            element(in: app, identifier: "synthetic-appointment").waitForExistence(timeout: 2)
        )
    }

    func testNewChatSurfaceIsImmediate() {
        let app = launchSyntheticApp(chatCount: 5_000)
        let newChat = app.buttons["synthetic-new-chat"]

        XCTAssertTrue(newChat.waitForExistence(timeout: 8))
        newChat.tap()
        XCTAssertTrue(
            element(in: app, identifier: "synthetic-new-chat-sheet").waitForExistence(timeout: 2)
        )
    }

    func testLaunchPerformanceWithFiveThousandChats() {
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)]) {
            let app = configuredSyntheticApp(chatCount: 5_000)
            app.launch()
            XCTAssertTrue(
                element(in: app, identifier: "synthetic-root").waitForExistence(timeout: 8)
            )
            app.terminate()
        }
    }

    /// Prueba prolongada opt-in del render, búsqueda y scroll del harness.
    /// No reemplaza una prueba E2E de backend, proveedores o datos productivos.
    /// `run-ios-chat-soak.sh` controla volumen/iteraciones sin sesión ni red.
    func testSyntheticChatSoak() {
        let environment = ProcessInfo.processInfo.environment
        let requestedCount = Int(environment["RISTAK_SOAK_CHAT_COUNT"] ?? "10000")
            ?? 10_000
        let chatCount = min(max(requestedCount, 1_000), 50_000)
        let requestedIterations = Int(environment["RISTAK_SOAK_ITERATIONS"] ?? "100")
            ?? 100
        let iterations = min(max(requestedIterations, 10), 2_000)

        let app = launchSyntheticApp(chatCount: chatCount)
        let list = element(in: app, identifier: "synthetic-chat-list")
        XCTAssertTrue(list.waitForExistence(timeout: 8))

        for iteration in 0..<iterations {
            if iteration.isMultiple(of: 7), iteration > 0 {
                list.swipeDown()
            } else {
                list.swipeUp()
            }

            if iteration.isMultiple(of: 25) {
                XCTAssertEqual(app.state, .runningForeground)
                XCTAssertTrue(list.exists)
            }
        }

        let search = app.textFields["synthetic-search"]
        XCTAssertTrue(search.exists)
        focusAndType(String(chatCount), into: search, app: app)
        XCTAssertTrue(
            element(in: app, identifier: "synthetic-chat-row-\(chatCount - 1)")
                .waitForExistence(timeout: 2),
            "La lista debe seguir respondiendo después del soak."
        )
    }

    /// Smoke de las vistas REALES (RootView → Login o MainShell). Es opt-in
    /// porque puede usar la sesión ya existente del simulador y su servidor
    /// configurado. Nunca recibe ni imprime credenciales desde el test.
    func testLiveAppSurfaceSmokeOptIn() throws {
        guard ProcessInfo.processInfo.environment["RISTAK_LIVE_SMOKE"] == "1" else {
            throw XCTSkip("Smoke real opt-in; usa RISTAK_LIVE_SMOKE=1 para ejecutarlo.")
        }

        let app = XCUIApplication()
        app.launchArguments = [
            "-AppleLanguages", "(es)",
            "-AppleLocale", "es_MX"
        ]
        launchedApp = app
        app.launch()

        let contentRoot = app.descendants(matching: .any)
            .matching(NSPredicate(
                format: "identifier == %@ OR identifier == %@",
                "ristak-login-root",
                "ristak-main-root"
            ))
            .firstMatch
        XCTAssertTrue(
            contentRoot.waitForExistence(timeout: 20),
            "La app real debe salir del splash y presentar login o shell."
        )

        if element(in: app, identifier: "ristak-login-root").exists {
            XCTAssertTrue(app.textFields["ristak-login-email"].exists)
            XCTAssertTrue(app.secureTextFields["ristak-login-password"].exists)
            XCTAssertTrue(app.buttons["ristak-login-submit"].exists)
        } else {
            XCTAssertTrue(element(in: app, identifier: "ristak-main-shell").exists)
        }
    }

    @discardableResult
    private func launchSyntheticApp(chatCount: Int) -> XCUIApplication {
        let app = configuredSyntheticApp(chatCount: chatCount)
        launchedApp = app
        app.launch()
        return app
    }

    private func configuredSyntheticApp(chatCount: Int) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "-ristak-ui-testing",
            "-AppleLanguages", "(es)",
            "-AppleLocale", "es_MX"
        ]
        app.launchEnvironment = [
            "RISTAK_UI_TEST_MODE": "synthetic",
            "RISTAK_SYNTHETIC_CHAT_COUNT": String(chatCount),
            // Evidencia revisable de que el harness jamás debe usar la red.
            "RISTAK_NETWORK_ACCESS": "disabled"
        ]
        return app
    }

    private func focusAndType(
        _ text: String,
        into field: XCUIElement,
        app: XCUIApplication
    ) {
        let focusControl = app.buttons["synthetic-search-focus"]
        XCTAssertTrue(focusControl.waitForExistence(timeout: 3))
        focusControl.tap()

        // `FocusState` es la fuente determinista. Esperar el teclado evita la
        // carrera que antes hacía `typeText` en el frame del tap.
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForExistence(timeout: 3),
            "El campo de búsqueda debe obtener foco antes de escribir."
        )
        field.typeText(text)
    }

    private func dismissKeyboard(in app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        let submitKey = app.keyboards.buttons["Search"]
        XCTAssertTrue(submitKey.waitForExistence(timeout: 2))
        submitKey.tap()
        XCTAssertTrue(
            app.keyboards.firstMatch.waitForNonExistence(timeout: 2),
            "La búsqueda debe cerrar el teclado antes de abrir una fila."
        )
    }

    private func element(
        in app: XCUIApplication,
        identifier: String
    ) -> XCUIElement {
        app.descendants(matching: .any)[identifier]
    }
}
