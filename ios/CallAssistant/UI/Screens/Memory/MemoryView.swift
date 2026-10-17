import SwiftUI

/// Экран «Память»: регулятор близости, профиль на стекле, «Сейчас в голове», карточки по категориям, техкарты, характер,
/// лента со свайпом, чувствительные темы, «Забыть всё».
/// Спецификация: docs/design/volna-memory-screen.html, техкарты и характер: docs/design/volna-techcards.html, карточки:
/// docs/design/canvas/memory-cards (доски «А» и «А′»).
struct MemoryView: View {
    @StateObject private var model = MemoryScreenModel()
    var callActive: Bool
    @State private var confirmForgetAll = false
    @State private var debugMode = MemoryPreferences().debugMode

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                levels
                if let error = model.error { ErrorCard(title: MemoryCopy.offlineTitle, text: error) }
                if let snapshot = model.snapshot {
                    if snapshot.level == .cold {
                        HStack(spacing: 12) {
                            Lamp(state: .off, size: 10)
                            Text(MemoryCopy.off).font(Wave.Fonts.body(13.5)).foregroundStyle(Wave.Palette.ink2)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20).padding(.vertical, 16)
                        .background(RoundedRectangle(cornerRadius: Wave.Radius.md, style: .continuous).fill(Wave.Palette.ivory).raised())
                        EmptyNote(text: MemoryCopy.coldExtras)
                        knowledge(snapshot)
                    } else {
                        if !snapshot.profile.isEmpty {
                            AnswerCard(title: MemoryCopy.profileTitle, text: snapshot.profile,
                                       footerLeading: "ОБНОВЛЕНО \(MemoryCopy.updatedLabel(snapshot.updatedAt))",
                                       footerTrailing: MemoryCopy.notesCount(snapshot.facts.count))
                                .accessibilityIdentifier("memoryProfile")
                        }
                        knowledge(snapshot)
                        if let cards = snapshot.techCards { techCards(cards) }
                        if let persona = snapshot.persona { character(persona) }
                    }
                    notes(snapshot)
                    sensitive(snapshot)
                    if debugMode { debug(snapshot) }
                    forgetAll
                }
            }
            .padding(.horizontal, 24).padding(.top, 16).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .refreshable { await model.reload() }
        .background(Wave.Palette.ivory.ignoresSafeArea())
        .toolbar { ToolbarItem(placement: .principal) { Text(MemoryCopy.title).font(Wave.Fonts.brand).foregroundStyle(Wave.Palette.bakelite) } }
        .toolbarBackground(Wave.Palette.ivory, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.reload() }
        .confirmationDialog(MemoryCopy.forgetAllConfirm, isPresented: $confirmForgetAll, titleVisibility: .visible) {
            Button(MemoryCopy.forgetAll, role: .destructive) { Task { await model.forgetAll() } }
        }
    }

    private var levels: some View {
        VStack(spacing: 10) {
            ForEach(MemoryLevel.allCases) { level in
                LevelRow(title: level.title, detail: level.detail, selected: model.level == level) {
                    guard !callActive else { model.notice = MemoryCopy.lockedDuringCall; return }
                    Task { await model.setLevel(level) }
                }
                .opacity(callActive && model.level != level ? 0.45 : 1)
                .accessibilityIdentifier("memoryLevel.\(level.rawValue)")
            }
            if let notice = model.notice {
                Text(notice).font(Wave.Fonts.caption).foregroundStyle(Wave.Palette.ink2).padding(.top, 4)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memoryLevel")
    }

    /// «Сейчас в голове» и карточки по категориям (docs/design/canvas/memory-cards, доска «А»).
    @ViewBuilder private func knowledge(_ snapshot: MemorySnapshot) -> some View {
        if !snapshot.threads.isEmpty {
            SettingsGroup(header: MemoryCopy.threadsHeader, shadow: .sm) {
                ForEach(Array(snapshot.threads.enumerated()), id: \.element.id) { index, fact in
                    if index > 0 { RowDivider() }
                    ThreadRow(fact: fact) { Task { await model.forget(fact) } }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("memoryThreads")
        }
        ForEach(snapshot.cardGroups) { group in
            SettingsGroup(header: group.title) {
                ForEach(Array(group.cards.enumerated()), id: \.element.id) { index, card in
                    if index > 0 { RowDivider() }
                    NavigationLink { MemoryCardView(cardID: card.id, model: model) } label: {
                        MemoryCardRow(card: card, count: snapshot.ownFacts(of: card).count)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("memoryCard.\(card.id)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("memoryCards.\(group.id)")
        }
    }

    private func techCards(_ cards: [TechCard]) -> some View {
        SettingsGroup(header: MemoryCopy.techCardsHeader) {
            if cards.isEmpty {
                EmptyNote(text: MemoryCopy.techCardsEmpty)
            } else {
                ForEach(Array(cards.enumerated()), id: \.element.id) { index, card in
                    if index > 0 { RowDivider() }
                    NavigationLink { TechCardView(cardID: card.id, model: model) } label: { TechCardRow(card: card) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("techCard.\(card.id)")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("memoryTechCards")
    }

    private func character(_ persona: PersonaSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(MemoryCopy.characterHeader.uppercased()).font(Wave.Fonts.status).tracking(1.3).foregroundStyle(Wave.Palette.ink2).padding(.leading, 20)
            NavigationLink { PersonaView(model: model) } label: { PersonaCard(persona: persona, title: MemoryCopy.personaTitle, showsCount: true) }
                .buttonStyle(KeyPressStyle(scale: 0.98))
                .accessibilityIdentifier("memoryPersona")
        }
    }

    /// С карточками здесь только лента: разговоры и ещё не разложенные записи; ядро старше 26.09.2026 отдаёт всё сюда.
    /// Когда всё разложено по карточкам и нитям, группы нет.
    @ViewBuilder private func notes(_ snapshot: MemorySnapshot) -> some View {
        let timeline = snapshot.timeline
        if snapshot.facts.isEmpty || !timeline.isEmpty { notesGroup(snapshot, timeline) }
    }

    private func notesGroup(_ snapshot: MemorySnapshot, _ timeline: [MemoryFact]) -> some View {
        SettingsGroup(header: snapshot.cards == nil ? MemoryCopy.notesHeader : MemoryCopy.timelineHeader) {
            if snapshot.facts.isEmpty {
                VStack(spacing: 12) {
                    WaveMark(size: .sm, state: .idle).scaleEffect(0.6).frame(width: 56, height: 56).opacity(0.45)
                    EmptyNote(text: MemoryCopy.empty)
                }
                .padding(.top, 14)
            } else {
                ForEach(Array(timeline.enumerated()), id: \.element.id) { index, fact in
                    if index > 0 { RowDivider() }
                    MemoryRow(fact: fact) { Task { await model.forget(fact) } }
                }
            }
        }
        .accessibilityIdentifier("memoryList")
    }

    private func sensitive(_ snapshot: MemorySnapshot) -> some View {
        SettingsGroup(header: MemoryCopy.sensitiveHeader) {
            Button { Task { await model.setAllowSensitive(!snapshot.allowSensitive) } } label: {
                SettingsRow(title: MemoryCopy.sensitiveRow) {
                    LampValue(text: snapshot.allowSensitive ? MemoryCopy.sensitiveOn : MemoryCopy.sensitiveOff, lamp: snapshot.allowSensitive ? .on : .off)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(MemoryCopy.sensitiveRow)
            .accessibilityValue(snapshot.allowSensitive ? MemoryCopy.sensitiveOn : MemoryCopy.sensitiveOff)
            RowDivider()
            SettingsNote(text: MemoryCopy.sensitiveNote)
        }
    }

    private func debug(_ snapshot: MemorySnapshot) -> some View {
        SettingsGroup(header: MemoryCopy.debugHeader) {
            SettingsRow(title: MemoryCopy.debugTranscripts) { MonoValue(text: "\(snapshot.transcripts ?? 0)") }
            RowDivider()
            SettingsRow(title: MemoryCopy.debugDream) {
                MonoValue(text: snapshot.lastDreamAt.map { MemoryCopy.updatedLabel($0) } ?? MemoryCopy.never)
            }
        }
    }

    private var forgetAll: some View {
        VStack(spacing: 6) {
            Button { confirmForgetAll = true } label: {
                Text(MemoryCopy.forgetAll).font(Wave.Fonts.label).foregroundStyle(Wave.Palette.signal)
                    .padding(.horizontal, 12).frame(height: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("forgetAll")
            Text(MemoryCopy.forgetAllNote).font(Wave.Fonts.mono(9.5)).tracking(1).foregroundStyle(Wave.Palette.ink2)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }
}

// MARK: - Model

@MainActor
final class MemoryScreenModel: ObservableObject {
    @Published var snapshot: MemorySnapshot?
    @Published var error: String?
    @Published var notice: String?
    private let client = MemoryClient()

    var level: MemoryLevel? { snapshot?.level ?? MemoryPreferences().lastLevel }

    func reload() async {
        if MemoryPreferences.isPreviewRun { apply(.preview); return }
        await perform { try await client.load() }
    }
    func setLevel(_ level: MemoryLevel) async {
        notice = nil
        if MemoryPreferences.isPreviewRun, var preview = snapshot { preview.level = level; apply(preview); return }
        await perform { try await client.setLevel(level) }
    }
    func setAllowSensitive(_ allowed: Bool) async { await perform { try await client.setAllowSensitive(allowed) } }
    func forget(_ fact: MemoryFact) async {
        if MemoryPreferences.isPreviewRun, var preview = snapshot { preview.facts.removeAll { $0.id == fact.id }; apply(preview); return }
        await perform { try await client.forget(id: fact.id) }
    }
    func forgetCard(_ card: MemoryCard) async {
        if MemoryPreferences.isPreviewRun, var preview = snapshot {
            let own = Set(preview.ownFacts(of: card).map(\.id))
            preview.facts.removeAll { own.contains($0.id) }
            preview.cards?.removeAll { $0.id == card.id }
            apply(preview); return
        }
        await perform { try await client.forgetCard(id: card.id) }
    }
    func forgetAll() async { await perform { try await client.forgetAll() } }
    func deleteTechCard(_ card: TechCard) async {
        if MemoryPreferences.isPreviewRun, var preview = snapshot { preview.techCards?.removeAll { $0.id == card.id }; apply(preview); return }
        await perform { try await client.deleteTechCard(id: card.id) }
    }
    func resetPersona() async {
        if MemoryPreferences.isPreviewRun, var preview = snapshot, let persona = preview.persona {
            preview.persona = PersonaSnapshot(traits: "", changes: [PersonaChange(at: preview.updatedAt, why: "Сброс к заводскому характеру по просьбе владельца.", after: "", calls: 0)] + persona.changes, lastReviewAt: persona.lastReviewAt)
            apply(preview); return
        }
        await perform { try await client.resetPersona() }
    }

    private func perform(_ action: () async throws -> MemorySnapshot) async {
        do { apply(try await action()); error = nil }
        catch { self.error = error.localizedDescription }
    }
    private func apply(_ snapshot: MemorySnapshot) {
        withAnimation(.easeInOut(duration: 0.2)) { self.snapshot = snapshot }
        var preferences = MemoryPreferences()
        preferences.lastLevel = snapshot.level
    }
}

// MARK: - Rows

/// Строка уровня: как `SelectableRow`, но с описанием второй строкой. Выбранное вдавлено, лампа горит только у выбранного.
struct LevelRow: View {
    var title: String
    var detail: String
    var selected: Bool
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Wave.Fonts.rowLabel).foregroundStyle(selected ? Wave.Palette.signal : Wave.Palette.bakelite)
                    Text(detail).font(Wave.Fonts.body(12)).foregroundStyle(Wave.Palette.ink2)
                }
                Spacer(minLength: 8)
                Lamp(state: selected ? .on : .off)
            }
            .padding(.horizontal, 18).padding(.vertical, 10)
            .frame(minHeight: 56)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous))
            .background {
                let shape = RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous)
                if selected { Color.clear.pressed(in: shape) } else { shape.fill(Wave.Palette.ivory).raised(.sm) }
            }
        }
        .buttonStyle(KeyPressStyle(shape: AnyShape(RoundedRectangle(cornerRadius: Wave.Radius.sm, style: .continuous)), scale: 0.97, feedback: .selection))
        .accessibilityLabel(title)
        .accessibilityHint(detail)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Строка записи со свайпом влево: за ней круглая красная клавиша «ЗАБЫТЬ».
struct MemoryRow: View {
    var fact: MemoryFact
    var forget: () -> Void

    var body: some View {
        ForgetSwipe(label: fact.text, forget: forget) {
            VStack(alignment: .leading, spacing: 5) {
                Text(fact.text).font(Wave.Fonts.body(14.5)).foregroundStyle(Wave.Palette.bakelite).lineSpacing(2)
                HStack(spacing: 10) {
                    Text(fact.label.uppercased()).font(Wave.Fonts.mono(10.5, .medium)).tracking(1)
                        .foregroundStyle(fact.isExplicit ? Wave.Palette.signal : Wave.Palette.ink2)
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .pressed(in: Capsule(), .sm)
                    Text(fact.dateLabel).font(Wave.Fonts.mono(10.5, .medium)).tracking(1).foregroundStyle(Wave.Palette.ink2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 10)
        }
        .accessibilityValue("\(fact.label), \(fact.dateLabel)")
    }
}

/// Свайп влево открывает круглую красную клавишу «ЗАБЫТЬ»; общий для записей и нитей.
struct ForgetSwipe<Content: View>: View {
    var label: String
    var forget: () -> Void
    @ViewBuilder var content: Content
    @State private var offset: CGFloat = 0
    @State private var open = false
    private let reveal: CGFloat = 76

    var body: some View {
        ZStack(alignment: .trailing) {
            Button(action: forget) {
                Text(MemoryCopy.forget).font(Wave.Fonts.mono(9.5, .medium)).tracking(1).foregroundStyle(Wave.Palette.light)
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(Wave.Palette.signal).raised(.sm))
            }
            .buttonStyle(KeyPressStyle(shape: AnyShape(Circle()), scale: 0.9, darkens: true, feedback: .impact(weight: .medium)))
            .padding(.trailing, 12)
            .opacity(open ? 1 : 0)
            .accessibilityLabel("Забыть: \(label)")
            .accessibilityHidden(!open)

            // Фон только в движении: в покое квадратная строка срезала бы скруглённые углы группы.
            content
                .background(offset == 0 ? Color.clear : Wave.Palette.ivory)
                .offset(x: offset)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 12)
                        .onChanged { value in
                            let base: CGFloat = open ? -reveal : 0
                            offset = min(0, max(-reveal - 12, base + value.translation.width))
                        }
                        .onEnded { value in
                            let shouldOpen = (open ? value.translation.width < reveal / 2 : value.translation.width < -reveal / 2)
                            withAnimation(.spring(duration: 0.28)) { open = shouldOpen; offset = shouldOpen ? -reveal : 0 }
                        }
                )
                .sensoryFeedback(.impact(weight: .light), trigger: open) { _, isOpen in isOpen }
                .onTapGesture { if open { withAnimation(.spring(duration: 0.28)) { open = false; offset = 0 } } }
        }
        .clipped()
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityAction(named: "Забыть", forget)
    }
}

struct EmptyNote: View {
    var text: String
    var body: some View {
        Text(text).font(Wave.Fonts.body(13.5)).foregroundStyle(Wave.Palette.ink2)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 18)
    }
}

struct MonoValue: View {
    var text: String
    var body: some View {
        Text(text.uppercased()).font(Wave.Fonts.mono(12, .medium)).tracking(0.8).foregroundStyle(Wave.Palette.ink2)
    }
}

#Preview("Память") {
    NavigationStack { MemoryView(callActive: false) }
}
