import SwiftUI
import Observation

// MARK: - Modelo de Precios Guardados (doc 08 §3 y §6.1 vista `products`)

@MainActor
@Observable
final class ProductsModel {
    private(set) var products: [ProductItem] = []
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var error: RistakAPIError?
    private(set) var accessDenied = false
    /// Id del producto que se está eliminando (spinner en su fila).
    private(set) var deletingID: String?

    // Formulario crear/editar.
    var editingProduct: ProductItem?
    var formName = ""
    var formPriceText = ""
    var formPriceName = ""
    var formDescription = ""
    private(set) var isSaving = false

    var validationTitle: String?
    var validationMessage: String?
    var pendingDelete: ProductItem?

    // MARK: Carga

    func load(refresh: Bool = false) async {
        if refresh {
            isRefreshing = true
        } else {
            isLoading = products.isEmpty
        }
        error = nil
        defer {
            isLoading = false
            isRefreshing = false
        }
        do {
            let result = try await ProductsService.products(limit: 100)
            products = result.products.filter { !$0.effectiveID.isEmpty }
            accessDenied = false
        } catch let apiError as RistakAPIError {
            if apiError.isAccessDenied {
                accessDenied = true
            } else if products.isEmpty {
                error = apiError
            }
        } catch {
            if products.isEmpty {
                self.error = RistakAPIError(kind: .server, status: 0, message: "No se pudieron cargar", underlying: error)
            }
        }
    }

    // MARK: Formulario

    func startCreate() {
        editingProduct = nil
        formName = ""
        formPriceText = ""
        formPriceName = ""
        formDescription = ""
    }

    func startEdit(_ product: ProductItem) {
        editingProduct = product
        formName = product.name
        formDescription = product.description ?? ""
        let price = product.prices.first
        formPriceName = price?.name ?? ""
        if let amount = price?.resolvedAmount {
            formPriceText = SinglePaymentModel.plainAmountText(amount)
        } else {
            formPriceText = ""
        }
    }

    /// Guarda el producto (payload /movil, doc 08 §6.1). Devuelve `true` si OK.
    func save(accountCurrency: String?) async -> Bool {
        guard !isSaving else { return false }

        let name = formName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            validationTitle = "Falta el nombre"
            validationMessage = "Escribe cómo se llama el producto."
            return false
        }
        guard let amount = PaymentsAmountParser.amount(from: formPriceText), amount > 0 else {
            validationTitle = "Falta el precio"
            validationMessage = "Escribe un precio válido para poder cobrarlo."
            return false
        }
        // Guard duro de moneda (doc 01 §10): los precios son registros de dinero.
        guard let accountCurrency else {
            validationTitle = "Falta la moneda de la cuenta"
            validationMessage = "No se pudo leer la moneda configurada del negocio. Reintenta cuando haya conexión."
            return false
        }

        isSaving = true
        defer { isSaving = false }

        let existingPrice = editingProduct?.prices.first
        let priceInput = ProductPriceInput(
            id: existingPrice?.id,
            localId: existingPrice?.localId,
            name: formPriceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Precio base"
                : formPriceName.trimmingCharacters(in: .whitespacesAndNewlines),
            amount: amount,
            currency: accountCurrency,
            type: "one_time"
        )

        let request = ProductSaveRequest(
            name: name,
            description: formDescription.isEmpty ? nil : formDescription,
            currency: accountCurrency,
            prices: [priceInput]
        )

        do {
            if let editingProduct {
                _ = try await ProductsService.updateProduct(id: editingProduct.effectiveID, request)
            } else {
                _ = try await ProductsService.createProduct(request)
            }
            await load(refresh: true)
            return true
        } catch let apiError as RistakAPIError {
            validationTitle = "No se pudo guardar"
            validationMessage = apiError.message
            return false
        } catch {
            validationTitle = "No se pudo guardar"
            validationMessage = "Intenta de nuevo."
            return false
        }
    }

    // MARK: Eliminar (soft delete del catálogo, doc 08 §3)

    func confirmDelete() async {
        guard let product = pendingDelete else { return }
        pendingDelete = nil
        deletingID = product.effectiveID
        defer { deletingID = nil }
        do {
            _ = try await ProductsService.deleteProduct(id: product.effectiveID)
            products.removeAll { $0.effectiveID == product.effectiveID }
        } catch let apiError as RistakAPIError {
            validationTitle = "No se pudo eliminar"
            validationMessage = apiError.message
        } catch {
            validationTitle = "No se pudo eliminar"
            validationMessage = "Intenta de nuevo."
        }
    }
}

// MARK: - Vista de Precios Guardados

struct ProductsFlowView: View {
    @State private var model = ProductsModel()
    var onDone: () -> Void = {}

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(AccessStore.self) private var access

    @State private var showFormSheet = false
    @State private var savedHaptic = false

    private var canWrite: Bool {
        access.canWrite(module: .payments)
    }

    var body: some View {
        Group {
            if model.accessDenied {
                PaymentsNoAccessView()
            } else if model.isLoading && model.products.isEmpty {
                RistakLoadingView(message: "Cargando productos…")
            } else if let error = model.error, model.products.isEmpty {
                RistakErrorState(message: error.message) {
                    Task { await model.load() }
                }
            } else if model.products.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .navigationTitle("Precios Guardados")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load()
        }
        .toolbar {
            if canWrite {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        model.startCreate()
                        showFormSheet = true
                    } label: {
                        Label("Nuevo", systemImage: "plus")
                    }
                    .accessibilityLabel("Nuevo producto")
                }
            }
        }
        .sheet(isPresented: $showFormSheet) {
            ProductFormSheet(model: model) {
                savedHaptic.toggle()
            }
            .presentationDetents([.medium, .large])
        }
        .sensoryFeedback(.success, trigger: savedHaptic)
        .alert(
            model.validationTitle ?? "Precios Guardados",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 {
                    model.validationMessage = nil
                    model.validationTitle = nil
                } }
            )
        ) {
            Button("Entendido", role: .cancel) {
                model.validationMessage = nil
                model.validationTitle = nil
            }
        } message: {
            Text(model.validationMessage ?? "")
        }
        .confirmationDialog(
            "Eliminar producto",
            isPresented: Binding(
                get: { model.pendingDelete != nil },
                set: { if !$0 { model.pendingDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: model.pendingDelete
        ) { _ in
            Button("Eliminar", role: .destructive) {
                Task { await model.confirmDelete() }
            }
            Button("Cancelar", role: .cancel) {
                model.pendingDelete = nil
            }
        } message: { product in
            Text("Se quitará \"\(product.name.isEmpty ? "Producto sin nombre" : product.name)\" de la lista para cobrar. Los pagos anteriores no se borran.")
        }
    }

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: RistakTheme.Spacing.md) {
                RistakEmptyState(
                    icon: "shippingbox",
                    title: "Sin productos todavía",
                    message: "Crea tu primer producto para cobrarlo rápido desde el celular."
                )

                if canWrite {
                    Button("Crear producto") {
                        model.startCreate()
                        showFormSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(.top, RistakTheme.Spacing.xxl)
        }
        .refreshable {
            await model.load(refresh: true)
        }
    }

    private var list: some View {
        List {
            Section(model.products.count == 1 ? "1 disponible" : "\(model.products.count) disponibles") {
                ForEach(model.products, id: \.effectiveID) { product in
                    productRow(product)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await model.load(refresh: true)
        }
    }

    private func productRow(_ product: ProductItem) -> some View {
        let price = product.prices.first
        let priceLabel: String = {
            guard let price, let amount = price.resolvedAmount else { return "Sin precio guardado" }
            let name = (price.name?.isEmpty == false) ? price.name! : "Precio base"
            return "\(name) · \(appConfig.formatters.currency(amount, currencyOverride: price.currency))"
        }()

        return HStack(spacing: RistakTheme.Spacing.sm) {
            Image(systemName: "shippingbox")
                .font(.body)
                .foregroundStyle(RistakTheme.accent)
                .frame(width: 38, height: 38)
                .background(
                    RoundedRectangle(cornerRadius: RistakTheme.Radius.small, style: .continuous)
                        .fill(RistakTheme.accentSoft)
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(product.name.isEmpty ? "Producto sin nombre" : product.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)

                Text((product.description?.isEmpty == false) ? product.description! : "Sin descripción")
                    .font(.caption)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(1)

                Text(priceLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            if canWrite {
                if model.deletingID == product.effectiveID {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button {
                        model.startEdit(product)
                        showFormSheet = true
                    } label: {
                        Image(systemName: "pencil")
                            .font(.subheadline)
                            .foregroundStyle(RistakTheme.textDim)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Editar producto")

                    Button(role: .destructive) {
                        model.pendingDelete = product
                    } label: {
                        Image(systemName: "trash")
                            .font(.subheadline)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Eliminar producto")
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Sheet de crear/editar producto

private struct ProductFormSheet: View {
    @Bindable var model: ProductsModel
    var onSaved: () -> Void

    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetScaffold(
            title: model.editingProduct == nil ? "Nuevo producto" : "Editar producto",
            subtitle: "Estos datos aparecerán al cobrar desde Guardados."
        ) {
            Form {
                Section {
                    TextField("Ej. Consulta inicial", text: $model.formName)

                    LabeledContent("Precio (\(appConfig.displayCurrencyCode))") {
                        TextField("0.00", text: $model.formPriceText)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                            .monospacedDigit()
                    }

                    TextField("Precio base", text: $model.formPriceName)

                    TextField("Agrega una nota corta para reconocerlo.", text: $model.formDescription, axis: .vertical)
                        .lineLimit(2...4)
                }

                Section {
                    Button {
                        Task {
                            let saved = await model.save(accountCurrency: appConfig.accountCurrency)
                            if saved {
                                onSaved()
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            if model.isSaving {
                                ProgressView()
                                    .controlSize(.small)
                            }
                            Text(model.isSaving ? "Guardando..." : "Guardar")
                                .font(.body.weight(.semibold))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.isSaving)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())

                    Button("Cancelar", role: .cancel) {
                        dismiss()
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
            .scrollContentBackground(.hidden)
        }
        .alert(
            model.validationTitle ?? "Producto",
            isPresented: Binding(
                get: { model.validationMessage != nil },
                set: { if !$0 {
                    model.validationMessage = nil
                    model.validationTitle = nil
                } }
            )
        ) {
            Button("Entendido", role: .cancel) {
                model.validationMessage = nil
                model.validationTitle = nil
            }
        } message: {
            Text(model.validationMessage ?? "")
        }
    }
}
