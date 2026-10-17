import SwiftUI

/// Экран характера: текущий личный слой на стекле, история изменений, возврат к заводскому.
/// Спецификация: docs/design/volna-techcards.html, экран 07; устройство: docs/memory-design.md, 8.
struct PersonaView: View {
    @ObservedObject var model: MemoryScreenModel
    @State private var confirmReset = false

    var body: some View {
        ScrollView {
            if let persona = model.snapshot?.persona {
                VStack(spacing: 18) {
                    PersonaCard(persona: persona, title: MemoryCopy.personaNowTitle, showsCount: false)
                    if !persona.changes.isEmpty {
                        SettingsGroup(header: MemoryCopy.personaHistoryHeader) {
                            ForEach(Array(persona.changes.enumerated()), id: \.element.id) { index, change in
                                if index > 0 { RowDivider() }
                                PersonaChangeRow(change: change)
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("personaHistory")
                    }
                    Text(MemoryCopy.personaHint).font(Wave.Fonts.body(12.5)).foregroundStyle(Wave.Palette.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)
                    if !persona.isFactory {
                        VStack(spacing: 6) {
                            Button { confirmReset = true } label: {
                                Text(MemoryCopy.resetPersona).font(Wave.Fonts.label).foregroundStyle(Wave.Palette.bakelite)
                                    .padding(.horizontal, 12).frame(height: 40).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("personaReset")
                            Text(MemoryCopy.resetPersonaNote).font(Wave.Fonts.mono(9.5)).tracking(1).foregroundStyle(Wave.Palette.ink2)
                        }
                    }
                }
                .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
            }
        }
        .scrollIndicators(.hidden)
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .toolbar { ToolbarItem(placement: .principal) { Text(MemoryCopy.characterTitle).font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite) } }
        .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(MemoryCopy.resetPersonaConfirm, isPresented: $confirmReset, titleVisibility: .visible) {
            Button(MemoryCopy.resetPersona) { Task { await model.resetPersona() } }
        }
    }
}

/// Характер на стекле: слова Волны о себе или приглушённый заводской текст.
struct PersonaCard: View {
    var persona: PersonaSnapshot
    var title: String
    /// В «Памяти» справа число изменений со стрелкой, на экране характера пусто.
    var showsCount: Bool
    var body: some View {
        let last = persona.changes.first
        AnswerCard(
            title: title,
            text: persona.isFactory ? MemoryCopy.personaFactory : persona.traits,
            footerLeading: persona.isFactory ? MemoryCopy.personaFactoryFooter : last.map { MemoryCopy.personaChanged($0.at) } ?? "",
            footerTrailing: showsCount && !persona.changes.isEmpty ? "\(MemoryCopy.changesCount(persona.changes.count)) ›" : "",
            muted: persona.isFactory
        )
        .accessibilityElement(children: .combine)
    }
}

/// Изменение характера: дата и число разговоров, причина, что стало (серая черта у возврата к заводскому).
struct PersonaChangeRow: View {
    var change: PersonaChange
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(MemoryCopy.changeMeta(change)).font(Wave.Fonts.mono(10.5, .medium)).tracking(1).foregroundStyle(Wave.Palette.ink2)
            Text(change.why).font(Wave.Fonts.body(13.5)).foregroundStyle(Wave.Palette.bakelite).lineSpacing(2)
            if !change.isFactory {
                Text(change.after).font(Wave.Fonts.body(13)).foregroundStyle(Wave.Palette.ink2).lineSpacing(2)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(Wave.Palette.lamp).frame(width: 2) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

#Preview("Характер") {
    NavigationStack { PersonaView(model: MemoryScreenModel()) }
}
