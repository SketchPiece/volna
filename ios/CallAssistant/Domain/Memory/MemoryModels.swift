import Foundation

/// Уровень близости: сколько Волна запоминает. Значения совпадают с ядром (`core/src/memory/model.ts`).
enum MemoryLevel: String, CaseIterable, Codable, Identifiable {
    case cold, explicit, attentive, involved

    var id: String { rawValue }
    var title: String {
        switch self {
        case .cold: "Холодная"
        case .explicit: "По просьбе"
        case .attentive: "Замечает сама"
        case .involved: "Вовлечённая"
        }
    }
    var detail: String {
        switch self {
        case .cold: "Ничего не запоминает и не записывает."
        case .explicit: "Только «запомни» и «забудь»."
        case .attentive: "Выделяет важное после звонка."
        case .involved: "Плюс спрашивает о твоих делах."
        }
    }
}

/// Запись памяти в том виде, в каком её отдаёт `GET /memory`.
struct MemoryFact: Codable, Identifiable, Equatable {
    var id: String
    var text: String
    var kind: String
    var origin: String
    var when: String?
    var learnedAt: String
    /// Карточки записи (id), первая своя. Нет у ядра старше 26.09.2026.
    var cards: [String]? = nil

    /// Метка вида; явная просьба пользователя важнее вида.
    var label: String {
        if origin == "explicit" { return MemoryCopy.explicitLabel }
        return MemoryCopy.kindLabels[kind] ?? kind
    }
    var isExplicit: Bool { origin == "explicit" }
    /// Дата для строки: дата события, иначе дата записи. Формат ДД.ММ.
    var dateLabel: String { MemoryCopy.shortDate(when ?? learnedAt) }
}

/// Карточка памяти: человек, проект, интерес, место или раздел о самом владельце (docs/memory-design.md, 9).
struct MemoryCard: Codable, Identifiable, Equatable {
    var id: String
    var kind: String
    var title: String
    var aliases: [String]
    var summary: String
    var updatedAt: String

    /// Разделы о самом владельце: по одной карточке, id совпадает с категорией.
    var isAboutOwner: Bool { MemoryCopy.ownerKinds.contains(kind) }
    /// Знак в кружке: у разделов о владельце свой, у остальных первая буква названия.
    var monogram: String { MemoryCopy.ownerMonograms[kind] ?? String(title.prefix(1)).uppercased() }
}

/// Группа карточек на экране «Память»: «О тебе» или одна категория.
struct MemoryCardGroup: Identifiable, Equatable {
    var id: String
    var title: String
    var cards: [MemoryCard]
}

/// Техкарта: правила владельца для дел одного рода. На телефоне только чтение, правится голосом.
struct TechCard: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var when: String
    var rules: [String]
    /// Номера правил (с нуля), появившихся в последней правке.
    var fresh: [Int]
    var updatedAt: String
    var versions: Int
}

/// Изменение личного слоя характера: когда, на что Волна опиралась, что стало. `after` пустой у возврата к заводскому.
struct PersonaChange: Codable, Identifiable, Equatable {
    var at: String
    var why: String
    var after: String
    var calls: Int
    var id: String { at }
    var isFactory: Bool { after.isEmpty }
}

/// Личный слой характера поверх заводского; изменения новыми вперёд.
struct PersonaSnapshot: Codable, Equatable {
    var traits: String
    var changes: [PersonaChange]
    var lastReviewAt: String?
    var isFactory: Bool { traits.isEmpty }
}

/// Снимок памяти из ядра. Лишние поля ответа игнорируются.
struct MemorySnapshot: Codable, Equatable {
    var level: MemoryLevel
    var allowSensitive: Bool
    var profile: String
    var facts: [MemoryFact]
    var updatedAt: String
    var lastDreamAt: String?
    var transcripts: Int?
    /// Нет у ядра старше 23.09.2026.
    var techCards: [TechCard]?
    var persona: PersonaSnapshot?
    /// Нет у ядра старше 26.09.2026: тогда все записи идут лентой, как раньше.
    var cards: [MemoryCard]? = nil

    /// Виды записей, которые живут в карточках; эпизоды и нити — лента.
    static let cardFactKinds: Set<String> = ["preference", "fact", "insight"]

    /// «Сейчас в голове»: открытые нити.
    var threads: [MemoryFact] { facts.filter { $0.kind == "thread" } }

    /// Группы карточек: сначала разделы о владельце, потом категории в порядке ядра; внутри как пришло (свежие первыми).
    var cardGroups: [MemoryCardGroup] {
        let cards = cards ?? []
        var groups: [MemoryCardGroup] = []
        let owner = MemoryCopy.ownerKinds.compactMap { kind in cards.first { $0.kind == kind } }
        if !owner.isEmpty { groups.append(MemoryCardGroup(id: "owner", title: MemoryCopy.ownerHeader, cards: owner)) }
        for (kind, title) in MemoryCopy.categoryTitles {
            let ofKind = cards.filter { $0.kind == kind }
            if !ofKind.isEmpty { groups.append(MemoryCardGroup(id: kind, title: title, cards: ofKind)) }
        }
        return groups
    }

    /// Свои записи карточки: факт, предпочтение или наблюдение, у которого она первая.
    func ownFacts(of card: MemoryCard) -> [MemoryFact] {
        facts.filter { Self.cardFactKinds.contains($0.kind) && $0.cards?.first == card.id }
    }

    /// Эпизоды, нити и чужие записи, которые ссылаются на карточку.
    func mentions(of card: MemoryCard) -> [MemoryFact] {
        facts.filter { ($0.cards ?? []).contains(card.id) && !(Self.cardFactKinds.contains($0.kind) && $0.cards?.first == card.id) }
    }

    /// Лента: всё, что не нить и не лежит в карточке (разговоры, наблюдения и ещё не разложенные записи).
    var timeline: [MemoryFact] {
        let known = Set((cards ?? []).map(\.id))
        return facts.filter { fact in
            fact.kind != "thread" && !(Self.cardFactKinds.contains(fact.kind) && known.contains(fact.cards?.first ?? ""))
        }
    }

    static let preview = MemorySnapshot(
        level: .attentive, allowSensitive: false,
        profile: "Инженер, живёт в Берлине, работает над голосовым ассистентом. Любит короткие ответы и лёгкую иронию, серьёзные темы обсуждает без шуток.",
        facts: [
            MemoryFact(id: "1", text: "Собаку зовут Рекс", kind: "fact", origin: "explicit", when: nil, learnedAt: "2026-09-21T10:00:00Z", cards: ["self"]),
            MemoryFact(id: "2", text: "Предпочитает короткие ответы", kind: "preference", origin: "inferred", when: nil, learnedAt: "2026-09-21T10:00:00Z", cards: ["style"]),
            MemoryFact(id: "3", text: "Встреча с врачом", kind: "thread", origin: "inferred", when: "2026-09-25", learnedAt: "2026-09-21T10:00:00Z"),
            MemoryFact(id: "4", text: "Обсуждали переезд в Мюнхен", kind: "episode", origin: "inferred", when: nil, learnedAt: "2026-09-22T09:41:00Z", cards: ["munich"]),
            MemoryFact(id: "5", text: "Сестру зовут Аня, живёт в Гамбурге", kind: "fact", origin: "inferred", when: nil, learnedAt: "2026-09-22T09:41:00Z", cards: ["anya"]),
            MemoryFact(id: "6", text: "Аня любит розы", kind: "preference", origin: "explicit", when: nil, learnedAt: "2026-09-22T09:41:00Z", cards: ["anya"]),
            MemoryFact(id: "7", text: "День рождения Ани", kind: "thread", origin: "inferred", when: "2026-10-03", learnedAt: "2026-09-22T09:41:00Z", cards: ["anya"]),
            MemoryFact(id: "8", text: "Ядро ассистента на TypeScript", kind: "fact", origin: "inferred", when: nil, learnedAt: "2026-09-22T09:41:00Z", cards: ["volna"]),
            MemoryFact(id: "9", text: "Лазает по выходным в зале", kind: "fact", origin: "inferred", when: nil, learnedAt: "2026-09-21T10:00:00Z", cards: ["climbing"])
        ],
        updatedAt: "2026-09-22T09:41:00Z", lastDreamAt: "2026-09-22T04:00:00Z", transcripts: 12,
        techCards: [
            TechCard(id: "tc1", title: "Разработка Волны", when: "Когда просишь поправить или доработать Волну",
                     rules: ["Проект CallAssistant в папке Hacking", "Задачу отдавать Claude в новом чате", "Интерфейс сначала HTML-макетом на одобрение",
                             "Сначала читать AGENTS.md", "Готово, когда npm test зелёный", "Ядро не перезапускать без меня"],
                     fresh: [5], updatedAt: "2026-09-23T09:41:00Z", versions: 3),
            TechCard(id: "tc2", title: "Новые приложения", when: "Когда просишь сделать приложение",
                     rules: ["iOS, SwiftUI", "Папка Hacking", "Сначала макет"], fresh: [], updatedAt: "2026-09-23T09:41:00Z", versions: 1)
        ],
        persona: PersonaSnapshot(
            traits: "С ним я прямее, чем задумано: не смягчаю, когда что-то не выйдет. Шучу суше и реже по утрам. Про код говорю его словами.",
            changes: [
                PersonaChange(at: "2026-09-26T04:00:00Z", why: "Трижды перебивал утренние шутки и отвечал только по делу.", after: "Шучу суше и реже по утрам.", calls: 6),
                PersonaChange(at: "2026-09-23T04:00:00Z", why: "Дважды просил не смягчать плохие новости про сборку.", after: "С ним я прямее, чем задумано.", calls: 5)
            ],
            lastReviewAt: "2026-09-26T04:00:00Z"),
        cards: [
            MemoryCard(id: "anya", kind: "person", title: "Сестра", aliases: ["Аня"], summary: "Живёт в Гамбурге, любит розы", updatedAt: "2026-09-22T09:41:00Z"),
            MemoryCard(id: "volna", kind: "work", title: "Голосовой ассистент", aliases: [], summary: "Свой проект: ядро на TypeScript", updatedAt: "2026-09-22T09:41:00Z"),
            MemoryCard(id: "munich", kind: "place", title: "Мюнхен", aliases: [], summary: "Думает о переезде", updatedAt: "2026-09-22T09:41:00Z"),
            MemoryCard(id: "self", kind: "self", title: "Обо мне", aliases: [], summary: "Инженер, живёт в Берлине, есть собака", updatedAt: "2026-09-21T10:00:00Z"),
            MemoryCard(id: "style", kind: "style", title: "Как со мной говорить", aliases: [], summary: "Коротко и с лёгкой иронией", updatedAt: "2026-09-21T10:00:00Z"),
            MemoryCard(id: "climbing", kind: "interest", title: "Скалолазание", aliases: [], summary: "По выходным в зале", updatedAt: "2026-09-21T10:00:00Z")
        ]
    )
}

/// Тексты экрана «Память» в одном месте, как `CallCopy` для звонка.
enum MemoryCopy {
    static let title = "Память"
    static let settingsRow = "Память"
    static let settingsNote = "что Волна знает о тебе"
    static let profileTitle = "ВОЛНА О ТЕБЕ"
    static let notesHeader = "Записи"
    static let sensitiveHeader = "Чувствительные темы"
    static let sensitiveRow = "Здоровье, политика, религия"
    static let sensitiveOn = "ХРАНИТЬ"
    static let sensitiveOff = "НЕ ХРАНИТЬ"
    static let sensitiveNote = "Пока выключено, Волна пропускает такие темы сама. По твоей просьбе «запомни» сохраняет всегда."
    static let debugHeader = "Отладка"
    static let debugTranscripts = "Разговоров в ядре"
    static let debugDream = "Последний «сон»"
    static let forgetAll = "Забыть всё"
    static let forgetAllNote = "ЗАПИСИ, ПРОФИЛЬ И РАЗГОВОРЫ · УРОВЕНЬ ОСТАЁТСЯ"
    static let forgetAllConfirm = "Забыть всё, что Волна знает?"
    static let forget = "ЗАБЫТЬ"
    static let empty = "Пока пусто. После первого разговора Волна запишет то, что стоит помнить."
    static let off = "Память выключена. Записи сохранены в ядре, но Волна их не читает."
    static let offline = "Память живёт в ядре. Проверь подключение в настройках и открой экран снова."
    static let offlineTitle = "ЯДРО НЕ ОТВЕЧАЕТ"
    static let lockedDuringCall = "Уровень уже вшит в текущий звонок. Изменится со следующего."
    static let explicitLabel = "просьба"
    static let kindLabels: [String: String] = [
        "preference": "общение", "fact": "факт", "episode": "разговор", "thread": "нить", "insight": "наблюдение"
    ]
    static let never = "ЕЩЁ НЕ БЫЛО"

    // Карточки: docs/design/canvas/memory-cards, доски «А» и «А′»
    static let threadsHeader = "Сейчас в голове"
    static let ownerHeader = "О тебе"
    static let ownerKinds = ["self", "style", "routine"]
    static let ownerMonograms = ["self": "Я", "style": "Г", "routine": "Б"]
    /// Категории, у которых карточек много, в порядке экрана.
    static let categoryTitles: [(String, String)] = [("person", "Люди"), ("work", "Работа и проекты"), ("interest", "Интересы"), ("place", "Места")]
    static let kindTitles = ["self": "Обо мне", "style": "Как со мной говорить", "routine": "Быт и привычки", "person": "Люди", "work": "Работа и проекты", "interest": "Интересы", "place": "Места"]
    static let timelineHeader = "Лента"
    static let cardKnownHeader = "Что Волна знает"
    static let cardMentionsHeader = "В разговорах"
    static let cardEmpty = "Своих записей пока нет. Волна добавит, когда узнает больше."
    static let forgetCard = "Забыть карточку"
    static let forgetCardNote = "ЗАПИСИ КАРТОЧКИ · РАЗГОВОРЫ ОСТАЮТСЯ"

    /// «ЛЮДИ · СЕСТРА · АНЯ»: категория, название, другие имена.
    static func cardHeader(_ card: MemoryCard) -> String {
        ([card.isAboutOwner ? ownerHeader : kindTitles[card.kind] ?? card.kind] + (card.isAboutOwner ? [] : [card.title]) + card.aliases)
            .joined(separator: " · ").uppercased()
    }
    static func forgetCardConfirm(_ title: String) -> String { "Забыть всё из карточки «\(title)»?" }

    // Техкарты и характер: docs/design/volna-techcards.html
    static let techCardsHeader = "Техкарты"
    static let techCardsEmpty = "Техкарт пока нет. Скажи Волне: «когда я прошу сделать приложение, делай так…» или ответь на её вопрос, и она заведёт."
    static let techCardTitle = "Техкарта"
    static let rulesHeader = "Правила"
    static let deleteTechCard = "Удалить техкарту"
    static let characterHeader = "Характер"
    static let characterTitle = "Характер"
    static let personaTitle = "ВОЛНА О СЕБЕ"
    static let personaNowTitle = "ВОЛНА О СЕБЕ · СЕЙЧАС"
    static let personaFactory = "Заводской характер. Свои черты с тобой появятся после нескольких разговоров."
    static let personaFactoryFooter = "ЗАВОДСКОЙ"
    static let personaHistoryHeader = "Как менялся"
    static let personaHint = "Характер складывается сам, раз в несколько дней и понемногу. Просьбу «говори короче» Волна исполняет сразу, это в записях памяти."
    static let resetPersona = "Вернуть заводской"
    static let resetPersonaNote = "ИСТОРИЯ ОСТАНЕТСЯ"
    static let resetPersonaConfirm = "Вернуть заводской характер?"
    static let coldExtras = "На уровне «Холодная» Волна не читает ни техкарт, ни своего характера: говорит заводским."

    static func whenLabel(_ title: String) -> String { "\(title.uppercased()) · КОГДА" }
    static func deleteTechCardConfirm(_ title: String) -> String { "Удалить техкарту «\(title)»?" }
    static func rulesCount(_ count: Int) -> String { "\(count) \(plural(count, "ПРАВИЛО", "ПРАВИЛА", "ПРАВИЛ"))" }
    static func changesCount(_ count: Int) -> String { "\(count) \(plural(count, "ИЗМЕНЕНИЕ", "ИЗМЕНЕНИЯ", "ИЗМЕНЕНИЙ"))" }
    static func personaChanged(_ iso: String) -> String { "ИЗМЕНЁН \(shortDate(iso))" }
    /// «26.09 · ПОСЛЕ 6 РАЗГОВОРОВ»; у возврата к заводскому «23.09 · ЗАВОДСКОЙ».
    static func changeMeta(_ change: PersonaChange) -> String {
        let tail = change.isFactory ? "ЗАВОДСКОЙ" : "ПОСЛЕ \(change.calls) \(plural(change.calls, "РАЗГОВОРА", "РАЗГОВОРОВ", "РАЗГОВОРОВ"))"
        return "\(shortDate(change.at)) · \(tail)"
    }
    static func techCardHint(_ card: TechCard) -> String {
        "Правится голосом: «Волна, в техкарту „\(card.title)“ добавь…». Изменено \(shortDate(card.updatedAt)) · \(card.versions) \(plural(card.versions, "версия", "версии", "версий"))."
    }

    static func notesCount(_ count: Int) -> String {
        "\(count) \(plural(count, "ЗАПИСЬ", "ЗАПИСИ", "ЗАПИСЕЙ"))"
    }

    /// Русское множественное число: 1 правило, 2 правила, 5 правил.
    static func plural(_ count: Int, _ one: String, _ few: String, _ many: String) -> String {
        let rem10 = count % 10, rem100 = count % 100
        return rem10 == 1 && rem100 != 11 ? one : (2...4).contains(rem10) && !(12...14).contains(rem100) ? few : many
    }

    /// «22.09» из ISO-даты или ISO-времени; неизвестный формат возвращается как есть.
    static func shortDate(_ iso: String) -> String {
        let day = iso.prefix(10)
        let parts = day.split(separator: "-")
        guard parts.count == 3 else { return iso }
        return "\(parts[2]).\(parts[1])"
    }

    /// «22.09 · 09:41» из ISO-времени в локальной зоне.
    static func updatedLabel(_ iso: String, timeZone: TimeZone = .current) -> String {
        guard let date = ISO8601DateFormatter.memory.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return shortDate(iso) }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.dateFormat = "dd.MM · HH:mm"
        return formatter.string(from: date)
    }
}

private extension ISO8601DateFormatter {
    static let memory: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
