import Foundation

/// Every phase-dependent string of the call screen in one place.
/// UI tests assert `status` for muted listening and ended: change those together with the tests.
enum CallCopy {
    /// Subtitle of the idle screen: a line from an old radio set's self-check. One is drawn per launch.
    static let idleStatuses = [
        "Все системы в норме.",
        "Лампы прогреты.",
        "Станция готова.",
        "Канал открыт.",
        "Готовность номер один.",
        "Питание подано. Эфир чист.",
    ]
    /// Fixed under `--memory-preview` so `DesignScreenshots` stay reproducible.
    static let idleStatus: String = ProcessInfo.processInfo.arguments.contains("--memory-preview")
        ? idleStatuses[1] : idleStatuses.randomElement()!

    /// Launch source of a call Volna placed herself after a background task (VoIP push).
    static let callbackSource = "Волна перезванивает"

    static func status(for state: CallState) -> String {
        switch state.phase {
        case .idle: return idleStatus
        case .connecting: return "Соединяю…"
        case .listening: return state.isMuted ? "Микрофон выключен" : "Слушаю"
        case .thinking: return "Думаю"
        case .speaking: return "Говорю"
        case .ended: return "Разговор завершён"
        case .failed: return "Звонок не состоялся, микрофон выключен."
        }
    }

    /// SF Symbol shown left of the status while the call is active; nil hides the icon.
    static func statusSymbol(for state: CallState) -> String? {
        switch state.phase {
        case .connecting: return "antenna.radiowaves.left.and.right"
        case .listening: return state.isMuted ? "mic.slash" : "ear"
        case .thinking: return "ellipsis"
        case .speaking: return "waveform"
        case .idle, .ended, .failed: return nil
        }
    }

    static func title(for phase: CallPhase) -> String {
        switch phase {
        case .idle: return "Говорит Волна."
        case .ended: return "Конец связи"
        case .failed: return "Помехи в эфире."
        default: return "Волна"
        }
    }

    static func callToAction(for phase: CallPhase) -> String {
        switch phase {
        case .failed: return "Повторить"
        case .ended: return "Позвонить снова"
        default: return "Позвонить Волне"
        }
    }

    static let demoLabel = "Демо · без микрофона и API"
    static let brand = "ВОЛНА-1"
    static let endCall = "Завершить звонок"
    static let cancelCall = "Отменить звонок"
    static let cancel = "Отменить"
    static let transcript = "Стенограмма"
    /// GPT-Live closed the session itself; the reason comes from `session.closed`.
    static func sessionClosed(_ reason: String) -> String {
        switch reason {
        case "expired": return "Сессия закончилась: истёк её лимит времени."
        case "content": return "Сессию остановил фильтр безопасности OpenAI."
        case "connection_lost": return "Связь с OpenAI потеряна."
        default: return "OpenAI завершил сессию."
        }
    }
    static let mute = "Микрофон"
    static let unmute = "Включить"
    static let settings = "Настройки"
    static let you = "ТЫ"
    static let wave = "ВОЛНА"
    static let waveSpeaking = "ВОЛНА · ГОВОРИТ"
    static let emptyTranscript = "Разговор появится здесь по ходу звонка."
    static let transcriptPrivacy = "Стенограммы последних 50 разговоров хранятся только на этом телефоне."
    static let previewTranscript = "Это предпросмотр экрана звонка. Реальный разговор начнётся по кнопке «Позвонить»."
    static func connectionSummary(_ seconds: Double?) -> String {
        guard let seconds else { return "ВЕСЬ ТЕКСТ ↗" }
        return String(format: "СОЕДИНЕНИЕ %.1f С", seconds)
    }

    // Errors raised by the coordinator itself
    static let microphoneDenied = "Разреши микрофон в Настройках → Волна."
    static let connectTimeout = "Подключение заняло слишком долго. Проверь ядро и сеть."
    static let aiFailed = "AI не смог ответить. Проверь лимиты API и повтори звонок."
    static let audioReset = "Аудиосистема перезапущена. Позвони снова."
    static let audioInterrupted = "Разговор прерван другим аудиособытием."
    static let callKitFailed = "iOS не смогла запустить звонок."
    static let autoSpeakerFailed = "Не удалось автоматически переключить динамик. Выбери аудиоустройство вручную."
    static let linkLost = "Связь прервалась. Начни новый звонок."
}
