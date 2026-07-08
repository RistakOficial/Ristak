import Foundation

/// Endpoints de catálogo de productos (doc research/08 §3). Módulo `payments`.
/// ⚠️ Estos endpoints NO usan el envelope `data`: los campos van al nivel raíz
/// (`{ success, products, total }`, `{ success, product, message }`, …).
enum ProductsService {
    /// `GET /api/products`.
    static func products(
        limit: Int = 100,
        offset: Int? = nil,
        query: String? = nil,
        includePrices: Bool = true,
        sync: Bool = false
    ) async throws -> ProductsListResult {
        try await APIClient.shared.get(
            "/api/products",
            query: [
                "limit": String(limit),
                "offset": offset.map(String.init),
                "query": query,
                "includePrices": includePrices ? nil : "false",
                "sync": sync ? "true" : nil,
            ],
            timeout: APIClient.dashboardTimeout
        )
    }

    /// `POST /api/products` → 201 `{ success, product, message }`.
    static func createProduct(_ request: ProductSaveRequest) async throws -> ProductMutationResult {
        try await APIClient.shared.post("/api/products", body: request)
    }

    /// `PUT /api/products/:productId` (actualiza también el precio base incluido).
    static func updateProduct(id: String, _ request: ProductSaveRequest) async throws -> ProductMutationResult {
        try await APIClient.shared.put("/api/products/\(id)", body: request)
    }

    /// `DELETE /api/products/:productId` — soft delete del catálogo visible;
    /// los pagos históricos no se tocan.
    static func deleteProduct(id: String) async throws -> APIAcknowledgment {
        try await APIClient.shared.delete("/api/products/\(id)")
    }

    /// `GET /api/products/:productId/prices` → `{ success, prices }`.
    static func prices(productID: String) async throws -> [ProductPrice] {
        try await APIClient.shared.get(
            "/api/products/\(productID)/prices",
            keyedUnder: "prices"
        )
    }

    /// `POST /api/products/:productId/prices` → 201 `{ success, price, message }`.
    static func createPrice(productID: String, _ price: ProductPriceInput) async throws -> ProductPriceMutationResult {
        try await APIClient.shared.post("/api/products/\(productID)/prices", body: price)
    }
}
