import SwiftUI

/// Экран техкарты: «когда», правила с номерами, подсказка про голос, удаление. Правила меняются только голосом
/// (решение владельца 23.09.2026). Спецификация: docs/design/volna-techcards.html, экран 06.
struct TechCardView: View {
    var cardID: String
    @ObservedObject var model: MemoryScreenModel
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    private var card: TechCard? { model.snapshot?.techCards?.first { $0.id == cardID } }

    var body: some View {
        ScrollView {
            if let card {
                VStack(spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(MemoryCopy.whenLabel(card.title)).font(Wave.Fonts.mono(10.5, .medium)).tracking(1.3).foregroundStyle(Wave.Palette.ink2)
                        Text(card.when).font(Wave.Fonts.body(13.5)).foregroundStyle(Wave.Palette.ink2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.vertical, 14)
                    .background(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).fill(Wave.Palette.ivory).raised())

                    SettingsGroup(header: MemoryCopy.rulesHeader) {
                        ForEach(Array(card.rules.enumerated()), id: \.offset) { index, rule in
                            if index > 0 { RowDivider() }
                            RuleRow(number: index + 1, text: rule, fresh: card.fresh.contains(index))
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("techCardRules")

                    Text(MemoryCopy.techCardHint(card)).font(Wave.Fonts.body(12.5)).foregroundStyle(Wave.Palette.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8)

                    Button { confirmDelete = true } label: {
                        Text(MemoryCopy.deleteTechCard).font(Wave.Fonts.label).foregroundStyle(Wave.Palette.signal)
                            .padding(.horizontal, 12).frame(height: 40).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("deleteTechCard")
                }
                .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
                .confirmationDialog(MemoryCopy.deleteTechCardConfirm(card.title), isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button(MemoryCopy.deleteTechCard, role: .destructive) { Task { await model.deleteTechCard(card) } }
                }
            }
        }
        .scrollIndicators(.hidden)
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .toolbar { ToolbarItem(placement: .principal) { Text(MemoryCopy.techCardTitle).font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite) } }
        .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: card == nil) { _, gone in if gone { dismiss() } }
    }
}

/// Строка техкарты в «Памяти»: название, когда применять, число правил.
struct TechCardRow: View {
    var card: TechCard
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(card.title).font(Wave.Fonts.rowLabel).foregroundStyle(Wave.Palette.bakelite)
                Text(card.when).font(Wave.Fonts.body(12)).foregroundStyle(Wave.Palette.ink2).lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(MemoryCopy.rulesCount(card.rules.count)).font(Wave.Fonts.mono(10.5, .medium)).tracking(1).foregroundStyle(Wave.Palette.ink2)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Wave.Palette.ink2.opacity(0.55))
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.title)
        .accessibilityValue("\(card.when), \(MemoryCopy.rulesCount(card.rules.count).lowercased())")
    }
}

/// Правило техкарты с номером; номер правила из последней правки красный.
struct RuleRow: View {
    var number: Int
    var text: String
    var fresh: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)").font(Wave.Fonts.mono(12, .medium)).foregroundStyle(fresh ? Wave.Palette.signal : Wave.Palette.ink2)
                .frame(minWidth: 18, alignment: .leading)
            Text(text).font(Wave.Fonts.body(14.5)).foregroundStyle(Wave.Palette.bakelite).lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(number). \(text)")
        .accessibilityHint(fresh ? "Новое правило" : "")
    }
}

#Preview("Техкарта") {
    NavigationStack { TechCardView(cardID: "tc1", model: MemoryScreenModel()) }
}
