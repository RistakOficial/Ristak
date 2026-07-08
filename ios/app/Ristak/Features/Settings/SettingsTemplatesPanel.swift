import SwiftUI

/// Ruta de navegación al detalle de plantilla (`WhatsAppTemplate` no es
/// `Hashable` en Core; se envuelve con hash por id).
struct SettingsTemplateRoute: Hashable {
    let template: WhatsAppTemplate

    static func == (lhs: SettingsTemplateRoute, rhs: SettingsTemplateRoute) -> Bool {
        lhs.template == rhs.template
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(template.id)
        hasher.combine(template.status)
    }
}

/// Panel «Plantillas» (doc 10 §5.1 `renderTemplates`): lista de plantillas de
/// WhatsApp con estado de Meta (APROBADA usable; RECHAZADA/PAUSADA/DESHABILITADA
/// bloqueadas), búsqueda y detalle solo lectura.
struct SettingsTemplatesPanel: View {
    @Environment(SettingsModel.self) private var model

    @State private var searchText = ""

    var body: some View {
        SettingsLoadStateView(
            state: model.templates,
            loadingMessage: "Cargando plantillas...",
            retry: { Task { await model.loadTemplates() } }
        ) { summary in
            content(summary: summary)
        }
        .navigationTitle("Plantillas")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.loadTemplates() }
        .navigationDestination(for: SettingsTemplateRoute.self) { route in
            SettingsTemplateDetailView(template: route.template)
        }
    }

    private func content(summary: WhatsAppTemplatesSummary) -> some View {
        let filtered = filteredTemplates(summary.items)

        return SettingsPanelScroll {
            SettingsActionCard(
                systemImage: "doc.text",
                title: "Plantillas de WhatsApp",
                subtitle: summary.blocked > 0
                    ? "\(summary.blocked) necesitan revisión."
                    : "Revisa estados y aprobaciones de Meta.",
                actionTitle: "Actualizar",
                isWorking: model.templates.isLoading
            ) {
                Task { await model.loadTemplates() }
            }

            if summary.items.isEmpty {
                SectionCard {
                    Text("Todavía no hay plantillas guardadas.")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, RistakTheme.Spacing.md)
                }
            } else if filtered.isEmpty {
                SectionCard {
                    Text("Sin resultados para «\(searchText)».")
                        .font(.subheadline)
                        .foregroundStyle(RistakTheme.textDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, RistakTheme.Spacing.md)
                }
            } else {
                SectionCard {
                    VStack(spacing: 0) {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { index, template in
                            NavigationLink(value: SettingsTemplateRoute(template: template)) {
                                templateRow(template)
                            }
                            .buttonStyle(.plain)

                            if index < filtered.count - 1 {
                                Divider().padding(.vertical, RistakTheme.Spacing.xs)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $searchText, prompt: "Buscar plantilla")
    }

    private func filteredTemplates(_ items: [WhatsAppTemplate]) -> [WhatsAppTemplate] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return items }
        return items.filter { template in
            template.name.localizedCaseInsensitiveContains(query)
                || (template.officialName?.localizedCaseInsensitiveContains(query) ?? false)
                || template.previewText.localizedCaseInsensitiveContains(query)
        }
    }

    // MARK: - Fila

    private func templateRow(_ template: WhatsAppTemplate) -> some View {
        HStack(alignment: .top, spacing: RistakTheme.Spacing.sm) {
            Image(systemName: "doc.text")
                .font(.body.weight(.medium))
                .foregroundStyle(RistakTheme.textDim)
                .frame(width: 28)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 3) {
                Text(template.name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .lineLimit(1)

                Text(template.previewText)
                    .font(.footnote)
                    .foregroundStyle(RistakTheme.textDim)
                    .lineLimit(2)

                if template.isBlocked {
                    Text(template.blockDetail)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(RistakTheme.neg)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: RistakTheme.Spacing.xs)

            SettingsTemplateStatusBadge(template: template)
        }
        .padding(.vertical, RistakTheme.Spacing.xxs)
        .contentShape(Rectangle())
    }
}

// MARK: - Badge de estado

/// Badge del estado de Meta: aprobada verde, bloqueada roja, resto pendiente.
struct SettingsTemplateStatusBadge: View {
    let template: WhatsAppTemplate

    var body: some View {
        Text(template.statusLabel)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(color)
            .background(Capsule().fill(softColor))
    }

    private var color: Color {
        if template.isApproved { return RistakTheme.pos }
        if template.isBlocked { return RistakTheme.neg }
        return RistakTheme.warn
    }

    private var softColor: Color {
        if template.isApproved { return RistakTheme.posSoft }
        if template.isBlocked { return RistakTheme.negSoft }
        return RistakTheme.warnSoft
    }
}

// MARK: - Detalle solo lectura

/// Detalle de plantilla, solo lectura (el CRUD vive en el escritorio).
struct SettingsTemplateDetailView: View {
    let template: WhatsAppTemplate

    var body: some View {
        SettingsPanelScroll {
            SectionCard {
                VStack(alignment: .leading, spacing: RistakTheme.Spacing.sm) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(template.name)
                                .font(.headline)
                                .foregroundStyle(RistakTheme.textPrimary)

                            if let official = template.officialName, !official.isEmpty, official != template.name {
                                Text(official)
                                    .font(.footnote)
                                    .foregroundStyle(RistakTheme.textDim)
                            }
                        }

                        Spacer(minLength: RistakTheme.Spacing.xs)

                        SettingsTemplateStatusBadge(template: template)
                    }

                    if template.isBlocked {
                        Text(template.blockDetail)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(RistakTheme.neg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            SectionCard(title: "Contenido") {
                Text(template.previewText)
                    .font(.body)
                    .foregroundStyle(RistakTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            SectionCard(title: "Detalles") {
                VStack(spacing: RistakTheme.Spacing.xs) {
                    detailRow(label: "Idioma", value: template.language)
                    detailRow(label: "Categoría", value: template.category)
                    detailRow(label: "Calidad", value: template.qualityRating)
                }
            }

            Text("Las plantillas se crean y editan desde el escritorio de Ristak.")
                .font(.footnote)
                .foregroundStyle(RistakTheme.textMute)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, RistakTheme.Spacing.xs)
        }
        .navigationTitle("Plantilla")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func detailRow(label: String, value: String?) -> some View {
        if let value, !value.isEmpty {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.subheadline)
                    .foregroundStyle(RistakTheme.textDim)
                Spacer(minLength: RistakTheme.Spacing.sm)
                Text(value)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(RistakTheme.textPrimary)
                    .multilineTextAlignment(.trailing)
            }
        }
    }
}
