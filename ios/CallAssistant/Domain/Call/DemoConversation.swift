import Foundation

/// Scripted exchange for the demo call: the owner asks, Volna thinks and answers.
/// Lets the call screen and the wave be tried in the simulator without a microphone or the API.
enum DemoConversation {
    struct Exchange: Equatable {
        var question: String
        var answer: String
    }

    static let exchanges: [Exchange] = [
        Exchange(question: "Какая завтра погода в Берлине?",
                 answer: "Завтра в Берлине облачно, около пятнадцати градусов, к вечеру дождь. Зонт лучше взять."),
        Exchange(question: "Напомни вечером купить молоко.",
                 answer: "Хорошо, напомню в семь вечера. Молоко, одна позиция."),
        Exchange(question: "Расскажи что-нибудь интересное.",
                 answer: "Осьминог пробует мир на вкус щупальцами: на каждой присоске тысячи рецепторов."),
        Exchange(question: "Сколько сейчас времени в Токио?",
                 answer: "В Токио глубокая ночь, почти три часа. Звонить туда сейчас не стоит."),
        Exchange(question: "Что у меня завтра в календаре?",
                 answer: "Завтра две встречи: созвон с командой в десять и обед в час. Вечер свободен."),
    ]

    /// Seconds of silence before the owner's first phrase and between exchanges.
    static let openingPause: Double = 2.5
    static let pauseBetween: ClosedRange<Double> = 2...3
    static let thinking: ClosedRange<Double> = 2...3
    /// Speaking pace: seconds per word.
    static let secondsPerWord: Double = 0.34

    /// Speech-like level 0…1 at `time` seconds into a phrase of `length` seconds: syllables about
    /// 4.5 per second with uneven stress, a short breath every fifth syllable, soft start and end.
    static func level(at time: Double, length: Double, seed: Int) -> Double {
        guard time >= 0, time <= length else { return 0 }
        let position = time * 4.5
        let syllable = Int(position)
        let within = position - Double(syllable)
        if syllable % 5 == 4 { return 0.02 }
        let edge = min(1, time / 0.25, (length - time) / 0.35)
        let stress = 0.45 + 0.55 * hash(syllable &* 31 &+ seed)
        return max(0, edge) * stress * pow(sin(.pi * within), 1.3)
    }

    /// Words with the spacing the transcript deltas need: the first bare, the rest with a leading space.
    static func deltas(_ text: String) -> [String] {
        text.split(separator: " ").enumerated().map { $0.offset == 0 ? String($0.element) : " " + $0.element }
    }

    private static func hash(_ n: Int) -> Double {
        let v = sin(Double(n) * 127.1 + 311.7) * 43758.5453
        return v - v.rounded(.down)
    }
}
