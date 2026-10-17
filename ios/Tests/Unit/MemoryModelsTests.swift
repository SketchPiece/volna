import XCTest
@testable import CallAssistant

/// Модели и тексты экрана «Память»; формат ответа должен совпадать с `GET /memory` ядра.
final class MemoryModelsTests: XCTestCase {
    func testSnapshotDecodesBridgeResponseAndIgnoresExtras() throws {
        let json = """
        {"transcripts":3,"level":"involved","levelTitle":"Вовлечённая","levels":[{"id":"cold","title":"Холодная"}],
         "allowSensitive":true,"profile":"Инженер.","facts":[
           {"id":"a1","text":"Собаку зовут Рекс","kind":"fact","origin":"explicit","when":null,"learnedAt":"2026-09-21T10:00:00.000Z"},
           {"id":"b2","text":"Встреча с врачом","kind":"thread","origin":"inferred","when":"2026-09-25","learnedAt":"2026-09-21T10:00:00.000Z"}],
         "updatedAt":"2026-09-22T09:41:00.000Z","lastDreamAt":null}
        """
        let snapshot = try JSONDecoder().decode(MemorySnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.level, .involved)
        XCTAssertTrue(snapshot.allowSensitive)
        XCTAssertEqual(snapshot.transcripts, 3)
        XCTAssertNil(snapshot.lastDreamAt)
        XCTAssertEqual(snapshot.facts.map(\.label), ["просьба", "нить"])
        XCTAssertEqual(snapshot.facts.map(\.dateLabel), ["21.09", "25.09"])
        XCTAssertTrue(snapshot.facts[0].isExplicit)
    }

    func testLevelsMatchTheBridgeAndHaveCopy() {
        XCTAssertEqual(MemoryLevel.allCases.map(\.rawValue), ["cold", "explicit", "attentive", "involved"])
        for level in MemoryLevel.allCases {
            XCTAssertFalse(level.title.isEmpty)
            XCTAssertFalse(level.detail.isEmpty)
        }
        XCTAssertEqual(MemoryLevel.attentive.title, "Замечает сама")
    }

    func testCopyFormatsCountsAndDates() {
        XCTAssertEqual(MemoryCopy.notesCount(1), "1 ЗАПИСЬ")
        XCTAssertEqual(MemoryCopy.notesCount(4), "4 ЗАПИСИ")
        XCTAssertEqual(MemoryCopy.notesCount(11), "11 ЗАПИСЕЙ")
        XCTAssertEqual(MemoryCopy.notesCount(22), "22 ЗАПИСИ")
        XCTAssertEqual(MemoryCopy.shortDate("2026-09-05"), "05.09")
        XCTAssertEqual(MemoryCopy.shortDate("странно"), "странно")
        XCTAssertEqual(MemoryCopy.updatedLabel("2026-09-22T09:41:00.000Z", timeZone: TimeZone(identifier: "UTC")!), "22.09 · 09:41")
        XCTAssertEqual(MemoryCopy.updatedLabel("2026-09-22T09:41:00Z", timeZone: TimeZone(identifier: "Europe/Berlin")!), "22.09 · 11:41")
        XCTAssertEqual(MemoryCopy.kindLabels["episode"], "разговор")
    }

    func testTechCardsAndPersonaDecodeAndOlderBridgesStillDecode() throws {
        let json = """
        {"level":"attentive","allowSensitive":false,"profile":"","facts":[],"updatedAt":"2026-09-23T09:41:00.000Z",
         "techCards":[{"id":"t1","title":"Разработка Волны","when":"когда просит","rules":["А","Б","В"],"fresh":[2],"updatedAt":"2026-09-23T09:41:00.000Z","versions":2}],
         "persona":{"traits":"","changes":[{"at":"2026-09-24T04:00:00.000Z","why":"Сброс","after":"","calls":0},
                                          {"at":"2026-09-23T04:00:00.000Z","why":"Просил прямее","after":"С ним я прямее.","calls":5}],"lastReviewAt":null}}
        """
        let snapshot = try JSONDecoder().decode(MemorySnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.techCards?.first?.fresh, [2])
        XCTAssertEqual(snapshot.persona?.isFactory, true)
        XCTAssertEqual(snapshot.persona?.changes.map(MemoryCopy.changeMeta), ["24.09 · ЗАВОДСКОЙ", "23.09 · ПОСЛЕ 5 РАЗГОВОРОВ"])
        let old = try JSONDecoder().decode(MemorySnapshot.self, from: Data(#"{"level":"cold","allowSensitive":false,"profile":"","facts":[],"updatedAt":"x"}"#.utf8))
        XCTAssertNil(old.techCards)
        XCTAssertNil(old.persona)
    }

    func testTechCardAndPersonaCopy() {
        XCTAssertEqual(MemoryCopy.rulesCount(1), "1 ПРАВИЛО")
        XCTAssertEqual(MemoryCopy.rulesCount(3), "3 ПРАВИЛА")
        XCTAssertEqual(MemoryCopy.rulesCount(6), "6 ПРАВИЛ")
        XCTAssertEqual(MemoryCopy.changesCount(2), "2 ИЗМЕНЕНИЯ")
        XCTAssertEqual(MemoryCopy.whenLabel("Разработка Волны"), "РАЗРАБОТКА ВОЛНЫ · КОГДА")
        XCTAssertEqual(MemoryCopy.personaChanged("2026-09-26T04:00:00Z"), "ИЗМЕНЁН 26.09")
        let card = MemorySnapshot.preview.techCards![0]
        XCTAssertEqual(MemoryCopy.techCardHint(card), "Правится голосом: «Волна, в техкарту „Разработка Волны“ добавь…». Изменено 23.09 · 3 версии.")
    }

    func testCardsGroupOwnerSectionsFirstAndSplitOwnFactsFromTheTimeline() throws {
        let json = """
        {"level":"attentive","allowSensitive":false,"profile":"","updatedAt":"x","facts":[
           {"id":"f1","text":"Маме нравятся розы","kind":"preference","origin":"explicit","when":null,"learnedAt":"2026-09-26T10:00:00Z","cards":["mom"]},
           {"id":"f2","text":"Звонил маме","kind":"episode","origin":"inferred","when":null,"learnedAt":"2026-09-26T10:00:00Z","cards":["mom"]},
           {"id":"f3","text":"Поздравить маму","kind":"thread","origin":"inferred","when":"2026-10-03","learnedAt":"2026-09-26T10:00:00Z","cards":["mom"]},
           {"id":"f4","text":"Отвечать короче","kind":"preference","origin":"inferred","when":null,"learnedAt":"2026-09-26T10:00:00Z","cards":["style"]},
           {"id":"f5","text":"Ещё не разложено","kind":"fact","origin":"inferred","when":null,"learnedAt":"2026-09-26T10:00:00Z","cards":[]}],
         "categories":[{"id":"self","title":"Обо мне"}],
         "cards":[
           {"id":"mom","kind":"person","title":"Мама","aliases":["Оля"],"summary":"Живёт в Берлине","updatedAt":"2026-09-26T10:00:00Z"},
           {"id":"work1","kind":"work","title":"Волна","aliases":[],"summary":"","updatedAt":"2026-09-25T10:00:00Z"},
           {"id":"style","kind":"style","title":"Как со мной говорить","aliases":[],"summary":"","updatedAt":"2026-09-24T10:00:00Z"}]}
        """
        let snapshot = try JSONDecoder().decode(MemorySnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.cardGroups.map(\.title), ["О тебе", "Люди", "Работа и проекты"])
        let mom = snapshot.cards![0]
        XCTAssertEqual(snapshot.ownFacts(of: mom).map(\.id), ["f1"])
        XCTAssertEqual(snapshot.mentions(of: mom).map(\.id), ["f2", "f3"], "the timeline mentions the card but stays in the timeline")
        XCTAssertEqual(snapshot.threads.map(\.id), ["f3"])
        XCTAssertEqual(snapshot.timeline.map(\.id), ["f2", "f5"])
        XCTAssertEqual(MemoryCopy.cardHeader(mom), "ЛЮДИ · МАМА · ОЛЯ")
        XCTAssertEqual(MemoryCopy.cardHeader(snapshot.cards![2]), "О ТЕБЕ")
        XCTAssertEqual(mom.monogram, "М")
        XCTAssertEqual(snapshot.cards![2].monogram, "Г")
        XCTAssertEqual(MemoryCopy.forgetCardConfirm("Мама"), "Забыть всё из карточки «Мама»?")
    }

    func testBridgeWithoutCardsKeepsEveryNoteInTheList() throws {
        let old = try JSONDecoder().decode(MemorySnapshot.self, from: Data(#"{"level":"attentive","allowSensitive":false,"profile":"","facts":[{"id":"a","text":"Любит джаз","kind":"preference","origin":"inferred","when":null,"learnedAt":"2026-09-21"}],"updatedAt":"x"}"#.utf8))
        XCTAssertNil(old.cards)
        XCTAssertTrue(old.cardGroups.isEmpty)
        XCTAssertEqual(old.timeline.map(\.id), ["a"])
    }
}
