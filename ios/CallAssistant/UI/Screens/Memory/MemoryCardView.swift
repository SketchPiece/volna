import SwiftUI

/// Экран карточки памяти: суть на стекле, свои записи, разговоры и нити, где она встречается, «Забыть карточку».
/// Спецификация: docs/design/canvas/memory-cards, доска «А′».
struct MemoryCardView: View {
    var cardID: String
    @ObservedObject var model: MemoryScreenModel
    @State private var confirmForget = false
    @Environment(\.dismiss) private var dismiss

    private var card: MemoryCard? { model.snapshot?.cards?.first { $0.id == cardID } }

    var body: some View {
        ScrollView {
            if let card, let snapshot = model.snapshot {
                let own = snapshot.ownFacts(of: card)
                let mentions = snapshot.mentions(of: card)
                VStack(spacing: 18) {
                    AnswerCard(title: MemoryCopy.cardHeader(card), text: card.summary.isEmpty ? card.title : card.summary,
                               footerLeading: "ОБНОВЛЕНО \(MemoryCopy.shortDate(card.updatedAt))",
                               footerTrailing: MemoryCopy.notesCount(own.count))

                    SettingsGroup(header: MemoryCopy.cardKnownHeader) {
                        if own.isEmpty {
                            EmptyNote(text: MemoryCopy.cardEmpty)
                        } else {
                            ForEach(Array(own.enumerated()), id: \.element.id) { index, fact in
                                if index > 0 { RowDivider() }
                                MemoryRow(fact: fact) { Task { await model.forget(fact) } }
                            }
                        }
                    }

                    if !mentions.isEmpty {
                        SettingsGroup(header: MemoryCopy.cardMentionsHeader, shadow: .sm) {
                            ForEach(Array(mentions.enumerated()), id: \.element.id) { index, fact in
                                if index > 0 { RowDivider() }
                                MemoryRow(fact: fact) { Task { await model.forget(fact) } }
                            }
                        }
                    }

                    VStack(spacing: 6) {
                        Button { confirmForget = true } label: {
                            Text(MemoryCopy.forgetCard).font(Wave.Fonts.label).foregroundStyle(Wave.Palette.signal)
                                .padding(.horizontal, 12).frame(height: 40).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("forgetCard")
                        Text(MemoryCopy.forgetCardNote).font(Wave.Fonts.mono(9.5)).tracking(1).foregroundStyle(Wave.Palette.ink2)
                    }
                    .padding(.top, 4)
                }
                .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
                .confirmationDialog(MemoryCopy.forgetCardConfirm(card.title), isPresented: $confirmForget, titleVisibility: .visible) {
                    Button(MemoryCopy.forgetCard, role: .destructive) { Task { await model.forgetCard(card) } }
                }
            }
        }
        .scrollIndicators(.hidden)
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .toolbar { ToolbarItem(placement: .principal) { Text(card?.title ?? "").font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite).lineLimit(1) } }
        .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: card == nil) { _, gone in if gone { dismiss() } }
    }
}

/// Строка карточки в «Памяти»: знак в кружке, название и другие имена, суть одной строкой, число своих записей.
struct MemoryCardRow: View {
    var card: MemoryCard
    var count: Int
    var body: some View {
        HStack(spacing: 14) {
            Text(card.monogram).font(Wave.Fonts.display(14)).foregroundStyle(card.isAboutOwner ? Wave.Palette.signal : Wave.Palette.bakelite)
                .frame(width: 38, height: 38)
                .pressed(in: Circle(), .sm)
            VStack(alignment: .leading, spacing: 2) {
                (Text(card.title).font(Wave.Fonts.rowLabel).foregroundStyle(Wave.Palette.bakelite)
                 + Text(card.aliases.isEmpty ? "" : " · \(card.aliases.joined(separator: ", "))").font(Wave.Fonts.text).foregroundStyle(Wave.Palette.ink2))
                    .lineLimit(1)
                if !card.summary.isEmpty {
                    Text(card.summary).font(Wave.Fonts.body(13)).foregroundStyle(Wave.Palette.ink2).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if count > 0 { Text("\(count)").font(Wave.Fonts.mono(11, .medium)).foregroundStyle(Wave.Palette.ink2) }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Wave.Palette.ink2.opacity(0.55))
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .frame(minHeight: 58)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.title)
        .accessibilityValue([card.summary, MemoryCopy.notesCount(count).lowercased()].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// Открытая нить в «Сейчас в голове»: горящая лампа, текст, дата; свайпом забывается, как запись.
struct ThreadRow: View {
    var fact: MemoryFact
    var forget: () -> Void
    var body: some View {
        ForgetSwipe(label: fact.text, forget: forget) {
            HStack(spacing: 14) {
                Lamp(state: .on, size: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(fact.text).font(Wave.Fonts.body(15, .medium)).foregroundStyle(Wave.Palette.bakelite)
                    if fact.when != nil {
                        Text(fact.dateLabel).font(Wave.Fonts.mono(10.5, .medium)).tracking(1).foregroundStyle(Wave.Palette.ink2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
        .accessibilityValue(fact.when == nil ? "" : fact.dateLabel)
    }
}

#Preview("Карточка") {
    NavigationStack { MemoryCardView(cardID: "anya", model: MemoryScreenModel()) }
}
