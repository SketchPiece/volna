import Foundation

/// Finished conversations for the home screen, newest first. A JSON file in Application Support, readable only
/// after the first unlock. A new record first gets the owner's first request as its title; the transcript then goes to
/// the core, which names the talk by its sense (`CallTitleClient`) and keeps nothing. `--memory-preview` shows a fixed
/// sample instead (design screenshots).
@MainActor
final class CallHistoryStore: ObservableObject {
    @Published private(set) var records: [CallRecord] = []
    /// How many conversations to keep on disk; the screen lists them all.
    static let keep = 1000
    private let url: URL?
    private let titles: CallTitleClient?

    init(url: URL? = CallHistoryStore.defaultURL, titles: CallTitleClient? = CallTitleClient()) {
        self.titles = titles
        if MemoryPreferences.isPreviewRun {
            self.url = nil
            // `--empty-home` shows the screen before the first conversation.
            records = ProcessInfo.processInfo.arguments.contains("--empty-home") ? [] : Self.sample(now: Date())
            return
        }
        self.url = url
        guard let url, let data = try? Data(contentsOf: url) else { return }
        records = (try? Self.decoder.decode([CallRecord].self, from: data)) ?? []
    }

    func add(_ record: CallRecord) {
        records = Array(([record] + records.filter { $0.id != record.id }).prefix(Self.keep))
        save()
        guard let titles, url != nil else { return }
        Task { [weak self] in
            guard let title = await titles.title(for: record.lines) else { return }
            self?.retitle(record.id, title)
        }
    }

    func retitle(_ id: UUID, _ title: String) {
        guard let index = records.firstIndex(where: { $0.id == id }), records[index].title != title else { return }
        records[index].title = title
        save()
    }

    private func save() {
        guard let url else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Self.encoder.encode(records).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            CallLaunchDiagnostics.record("history.saveFailed")
        }
    }

    nonisolated static var defaultURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("calls.json")
    }
    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    private static func sample(now: Date) -> [CallRecord] {
        // Anchored at 9:41 today, the time of the screenshots' status bar, so «Сегодня, …» never reads later than the clock.
        let nineFortyOne = Calendar.current.date(bySettingHour: 9, minute: 41, second: 0, of: now) ?? now
        let now = min(now, nineFortyOne)
        let talks: [(Double, Double, String)] = [
            (0.6, 4, "Что нового в почте с утра"),
            (15, 4, "Что такое резонанс, по-простому"),
            (18.5, 2, "Перенести встречу с Олегом на пятницу"),
            (50, 11, "План переезда: что везти первым"),
            (63, 1, "Погода в Тбилиси на выходные"),
            (79, 6, "Идеи подарка маме"),
            // Enough to scroll the page past the title and fold the call key (docs/design/canvas/home-scroll).
            (86, 3, "Рецепт хачапури по-аджарски"),
            (101, 9, "Почему падают тесты в «Заметках»"),
            (108, 2, "Сколько идти до вокзала пешком"),
            (121, 5, "Почему небо синее"),
            (130, 4, "Напомнить позвонить врачу"),
            (150, 8, "Разбор расходов за сентябрь"),
        ]
        return talks.enumerated().map { index, talk in
            let (hours, minutes, title) = talk
            return CallRecord(id: UUID(), startedAt: now.addingTimeInterval(-hours * 3600), duration: minutes * 60, title: title,
                              lines: index == 0 ? sampleTalk : [TranscriptLine(id: 0, speaker: .you, text: title, offset: 2)])
        }
    }

    /// The newest sample conversation in full: mail, a reminder and a job handed to Helm. Invented people and projects.
    private static let sampleTalk: [TranscriptLine] = [
        (TranscriptLine.Speaker.you, "Привет. Что нового в почте с утра?", 2.0),
        (.wave, "Посмотрела почту: три новых письма. Ольга прислала смету по ремонту и просит ответить до пятницы, банк прислал выписку, остальное рассылки.", 6),
        (.you, "Что в смете по итогу?", 21),
        (.wave, "Итог сто восемьдесят тысяч, половина из них кухня. Ещё она спрашивает, можно ли начать в понедельник.", 24),
        (.you, "Напомни мне ответить ей сегодня в шесть.", 38),
        (.wave, "Готово: напоминание на 18:00, «Ответить Ольге про смету».", 41),
        (.you, "И ещё: в «Заметках» не работает экспорт. Пусть агент посмотрит.", 52),
        (.wave, "Мне кажется, это работа для Штурвала: найти, почему не срабатывает экспорт, и починить. Сделать?", 57),
        (.you, "Да, давай.", 66),
        (.wave, "Отправила задачу в Штурвал, проект «Заметки». Как будет готово, напишу или перезвоню.", 68),
    ].enumerated().map { TranscriptLine(id: $0.offset, speaker: $0.element.0, text: $0.element.1, offset: $0.element.2) }
}
