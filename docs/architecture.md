# Архитектура Волны

Документ описывает, как приложение устроено сейчас, какую целевую структуру мы держим в голове и как к ней двигаться без остановки разработки. Обновляй его при каждом изменении границ модулей, потоков данных или инвариантов. Не дублируй сюда README: там установка и статус, здесь устройство.

Связанные документы: [README](../README.md) (запуск, статус), [ядро](core.md) (устройство ядра и инструменты), [дизайн-система](design/volna-design-system.html) (визуальный язык), [проверки на устройстве](device-checklist.md), [настройка устройства](device-setup.md), [расследование Siri](siri-investigation.md).

## 1. Что это за система

Волна делает одно действие: по тапу или по фразе «Siri, позвони Волне» открывает голосовой разговор с AI. Четыре участника:

| Участник | Технологии | Что хранит | Что не делает |
|---|---|---|---|
| iPhone-приложение `CallAssistant` | SwiftUI, CallKit, AVAudioSession, WebRTC (SPM `stasel/WebRTC` 153.0.0), Intents | Адрес ядра в UserDefaults, токен ядра в Keychain, выбранный голос | Не хранит API-ключ, аудио и историю |
| Siri-расширение `SiriExtension` | SiriKit `INStartCallIntent` | Ничего | Не звонит сам: только резолвит контакт «Волна» и отдаёт `continueInApp` |
| Ядро `core/` | Node ≥ 22.18, TypeScript без сборки, Hono, zod; устройство в [core.md](core.md) | `OPENAI_API_KEY`, `BRIDGE_TOKEN`, модель, часовой пояс в `.env`; долговременная память и транскрипты звонков в `core/data/` ([memory-design.md](memory-design.md)) | Не проксирует звук, не логирует SDP, тексты и аргументы инструментов |
| helm-cloud (отдельный репозиторий `~/Documents/Projects/helm-cloud`, сервис Railway `helm`) | Node ≥ 22.18, Hono; устройство в его README и `docs/` | Токены «Узла» и свой `INTERNAL_TOKEN` (у ядра `HELM_INTERNAL_TOKEN`) | Логики «Работы» не держит: передаёт вызовы ядра (`POST /internal/relay`, `core/src/relay/link.ts`) «Узлу» на Mac, который исполняет запросы и RPC-команды «Штурвала» из белого списка, проверку папки и git-репозитория; разрешений агенту не даёт |
| OpenAI Realtime | WebRTC, data channel `oai-events` | Сессия на время звонка | — |

Поток звонка: приложение собирает SDP-offer → `POST /session` в ядро с голосом и списком инструментов телефона в заголовках → ядро создаёт GPT-Live-сессию (`POST /v1/live/sessions`, транспорт WebRTC) с инструкциями характера и клиентским делегированием, отдаёт SDP-answer → звук идёт напрямую между iPhone и OpenAI по WebRTC, события по data channel. Параллельно ядро держит sideband-WebSocket к той же сессии (`/attach`): отвечает на делегирование моделями OpenRouter, исполняет инструменты ядра (время, память, поиск), пишет транскрипт. Инструменты телефона (напоминания, календарь, контакты) ядро кладёт в очередь `/device-tools`; их забирает долгим опросом и исполняет само приложение через EventKit и Contacts. Дизайн: [design/volna-tools.html](design/volna-tools.html).

### Целевая связь «Штурвала» (решение 03.10.2026)

Мобильный «Штурвал» (форк мобильного T3 Cloud) связывается с настольным «Штурвалом» через Tailscale. Облачное ядро Волны продолжает управлять работой через helm-cloud и исходящий WebSocket «Узла»; этот путь не переводим на Tailscale. Оба канала ведут к одному настольному исполнителю с общими заданиями, состояниями и проверками разрешений. В будущем «Узел» может стать модулем «Штурвала» с сохранением протокола ядра; сейчас отдельный relay остаётся в автозапуске. Это план, интеграция и её задержки ещё не проверены. Подробности и критерии проверки: `helm-cloud/docs/relay.md`, раздел 7.

## 2. Принципы

1. **Тонкий клиент, секреты в ядре.** Ключ OpenAI существует только в `core/.env`. Клиент знает адрес ядра и, при необходимости, токен ядра.
2. **Один источник правды о звонке.** Всё состояние звонка живёт в одном объекте на главном акторе. UI только читает его и вызывает команды.
3. **CallKit на устройстве, прямая аудиосессия в симуляторе.** Обе реализации за протоколом `SystemCallService`; выбор только в `AppContainer` под `#if targetEnvironment(simulator)`.
4. **Клиент ничего не сохраняет на диск, кроме настроек.** Транскрипт на телефоне только в памяти. Диагностика (`CallLaunchDiagnostics`) пишет только стадии, никогда текст, звук, URL или ключи. Долговременная память живёт в ядре (личное ядро владельца, решение 22.09.2026): транскрипты и извлечённые записи в `core/data/`, объём хранения задаёт регулятор близости, см. [memory-design.md](memory-design.md).
5. **Интерфейс собирается из дизайн-системы.** Цвета, шрифты, тени, компоненты берутся из `UI/Theme` и `UI/Components`. Новый экран не вводит новых цветов и стилей.
6. **Тесты как контракт.** Идентификаторы доступности и тексты, которые проверяют UI-тесты, менять только вместе с тестами.
7. **Документы не раздуваем.** Факты о проекте живут в одном месте, остальные документы ссылаются.

## 3. Структура (после перехода 21.09.2026)

Репозиторий (раскладка с 27.09.2026):

```
ios/          iOS-приложение: CallAssistant.xcodeproj, CallAssistant/, SiriExtension/, Shared/, Tests/, scripts/; команды запускаются из ios/
core/       ядро на Node; устройство в core.md, работа на Railway в railway.md
docs/         документы, дизайн-система, холсты
scripts/      скрипты уровня репозитория (remote-control-agent.sh)
archive/      не в работе: pult/ (Mac-приложение «Пульт», deprecated с 26.09.2026), speakerbox/ (диагностика Zorava для Siri)
```

Внутри `ios/`:

```
CallAssistant/
  App/
    CallAssistantApp.swift     UIApplicationDelegate + UIWindowSceneDelegate. Приём NSUserActivity от Siri, URL-схемы callassistant://call, корневой UIHostingController
    AppContainer.swift         Сборка зависимостей координатора; единственное место, где выбирается CallKit или симулятор
    Settings.swift             ConnectionSettings: endpoint (UserDefaults), token (Keychain), voice; проверка URL; RealtimeVoice; VoiceError
  Domain/Home/                 CallRecord (разговор для главного экрана и его заголовок), HomeMode, WorkTask (ответ GET /tasks), HomeCopy (подписи строк, порядок «Работы»)
  Domain/Memory/MemoryModels.swift  MemoryLevel, MemoryFact, MemorySnapshot (формат GET /memory ядра), MemoryCopy: тексты экрана «Память»
  Domain/Call/                 Чистый Swift, только Foundation
    CallState.swift            CallPhase, LampState, CallState (снимок для UI)
    CallEvent.swift            Все события, меняющие состояние
    CallReducer.swift          Чистая функция переходов; поздние события прошлого звонка игнорируются по фазе
    CallCopy.swift             Все тексты экрана звонка и ошибок координатора
  Services/
    SystemCallService.swift    Протокол + CallKitCallService (устройство) + SimulatorCallService
    AudioRouting.swift         Аудиосессия WebRTC, маршруты, датчик приближения, прерывания
    RingbackPlayer.swift       Звук ожидания, пока звонок «Соединяю…» (петля из Domain/Call/Ringback.swift)
    WaitMusicPlayer.swift      Музыка ожидания, пока идёт работа (эксперимент; решает Domain/Call/WaitMusic, мелодии Domain/Call/WaitTunes)
    Permissions.swift          Микрофон и Siri
    RealtimeTransport.swift    Протокол транспорта и RealtimeEvent (ready, failure, message, level)
    CallHistoryStore.swift     До 1000 разговоров в Application Support (calls.json); заголовок от ядра (CallTitleClient); образец под --memory-preview
    CallTitleClient.swift      POST /calls/title: ядро называет разговор по стенограмме
    WorkFeed.swift             «Работа» главного экрана: GET /tasks ядра (TasksClient) и напоминания на сегодня, опрос раз в 15 с, пока список виден
    MemoryClient.swift         HTTP к /memory ядра; MemoryPreferences: последний уровень и режим отладки в UserDefaults, флаг --memory-preview для снимков
  Calling/
    CallCoordinator.swift      Оркестратор: команды → сервисы → события → CallReducer → @Published state; SystemCallDelegate
  Voice/
    RealtimeClient.swift       WebRTC-реализация RealtimeTransport; опрос уровней звука из статистики соединения
  Siri/
    SiriInvocation.swift       Язык Siri, словарь, подсказка фразы
  UI/
    Theme/WaveTheme.swift     Палитра (светлая и «чёрный бакелит» по системной настройке), шрифты, тени
    Components/                WaveMark (с реальным уровнем голоса), лампы, кнопки, карточки, строки, группы
    Screens/Call/CallView.swift        CallView (обвязка координатора и листов) + CallScreen (чистый экран от CallState) + превью всех фаз
    Screens/Call/HomeList.swift        Список главного экрана: все разговоры с прокруткой (ленивые строки) или «Работа», столько строк, сколько помещается (до шести)
    Screens/Settings/SettingsView.swift   Группы: голос, память, подключение, первый запуск, Siri, проверка интерфейса (демо, режим отладки)
    Screens/Memory/MemoryView.swift       Экран «Память»: LevelRow, MemoryRow и ForgetSwipe, профиль в AnswerCard, «Сейчас в голове», группы карточек, MemoryScreenModel
    Screens/Memory/MemoryCardView.swift   Экран карточки памяти, MemoryCardRow, ThreadRow
    Screens/Voice/VoicePickerView.swift
    Sheets/CallSheets.swift    Стенограмма идущего звонка и прошлого разговора (TranscriptPanel)
  Resources/                   Локализация ru/en, шрифты OFL, Assets.xcassets
Shared/                        WaveContact, CallLaunchDiagnostics: компилируются в приложение и в расширение
SiriExtension/IntentHandler.swift
Tests/
  Unit/                        CallReducerTests, CallCopyTests, ConnectionSettingsTests, MemoryModelsTests (таргет CallAssistantTests, хостится приложением)
  UI/                          CallAssistantUITests, DesignScreenshots
scripts/
  sync-project.rb              Синхронизирует .xcodeproj с папками: добавляет новые Swift-файлы, удаляет пропавшие, создаёт unit-таргет
  generate-project.rb          Полная регенерация проекта
  add-design-resources.rb      Точечная регистрация шрифтов и каталога ресурсов
  configure-device.py          Адрес и токен ядра в установленную Debug-сборку
```

### 3.1 Состояние звонка

`CallPhase`: `idle → connecting → listening ⇄ thinking ⇄ speaking → ended | failed`; `ended → idle` по событию `.reset`, которое координатор шлёт через 3 с (`endedScreenDuration`), `failed` ждёт действия пользователя. `CallState` хранит фазу и `isMuted`, `isSpeaker`, `route`, `error`, `requestedAt`, `linkReady` и `sessionReadyAt` (сессия поднята, звонок ещё не отвечен), `startedAt` (момент ответа, от него идёт таймер), `connectionTime` (от запроса до ответа, приветствие входит), `transcript` (текущий ответ), `lines` (вся стенограмма звонка: `TranscriptLine` с автором, текстом и смещением от начала), `openLine`, `launchSource`, `isDemo`; производные `active`, `connected` (звонок отвечен: таймер и кнопки), `live` (сессия поднята, отвечен звонок или нет: звук, стенограмма, инструменты, приветствие) и `status`.

Все переходы в `CallReducer.reduce(state, event)`. GPT-Live полнодуплексна и не присылает событий хода реплик, поэтому фазы выводит сам клиент: чистая структура `SpeechActivity` (`Domain/Call`) по уровням звука из статистики WebRTC (10 Гц) и фрагментам транскрипта. Уровень выше 0.12 или фрагмент транскрипта начинает реплику стороны (`.outputStarted` для Волны, `.speechStarted` для пользователя), 0.9 с (Волна) или 0.7 с (пользователь) тишины ниже 0.05 заканчивают её (`.outputStopped`, `.speechStopped`). `session.output_transcript.delta → .transcriptDelta`, `session.input_transcript.delta → .inputTranscriptDelta`; оба фрагмента дописываются в открытую реплику того же автора в `lines` или открывают новую, `.outputStarted` и `.speechStarted` закрывают реплику собеседника. Стенограмма живёт в `CallState` до следующего звонка; когда отвеченный не демо-звонок заканчивается (`active` → `ended | failed`), координатор складывает её в `CallRecord` и через 0,7 с отдаёт `CallHistoryStore` (с 26.09.2026). После `.speechStopped` фаза `thinking` держится не дольше четырёх секунд без ответа: полнодуплексная модель не обязана отвечать на каждую реплику. `session.closed` с причинами `expired | content | connection_lost` завершает звонок ошибкой, остальные причины как обычное завершение. Редьюсер игнорирует события разговора вне `connected`, поэтому поздние колбэки прошлого звонка безвредны. Тексты для каждой фазы в `CallCopy`.

Кнопки «Перебить» нет: перебивание только голосом, его делает сама модель. Приветствие просит телефон, момент выбирает `GreetingGate` (`Domain/Call`, чистая структура с unit-тестами): Live исполняет просьбу только при идущем входном звуке, а микрофон на iPhone начинает течь, когда CallKit активирует аудиосессию, и это случается как до, так и после `session.started`. Поэтому `CallCoordinator` ждёт оба события, через 0,5 с шлёт `transport.requestGreeting()` (`session.instructions.append`, `delegation_id: null`, короткая просьба поздороваться) и повторяет её один раз, если за 4 с не было ни звука, ни стенограммы Волны; любая её речь закрывает шлюз. Шлюз же решает, когда звонок отвечен (`GreetingGate.Action.answer`, с 23.09.2026): `session.started` даёт только `.sessionReady`, фаза остаётся `connecting` («Соединяю…», без таймера, кнопка «Отменить»), а `.answered` приходит по первому звуку или стенограмме Волны, по первой расшифрованной фразе владельца (уровень микрофона не считается, это может быть шум) или после 4 с тишины за вторым запросом. Только тогда идёт таймер, `CallKitCallService.reportConnected` (время на экране блокировки и в «Недавних») и донат `INInteraction`. 35-секундный тайм-аут подключения действует до ответа. До 22.09.2026 просьба уходила сразу по `session.started`, и в живых звонках приветствие приходило через 6–40 с или после первой реплики пользователя. Саму фразу с 25.09.2026 выбирает ядро из набора по времени суток, давности прошлого звонка и имени из памяти, изредка с отсылкой к легенде (`greeting/phrases.ts`, [core.md, 4j](core.md#4j-приветствие)); с 23.09 по 25.09 её сочиняла дешёвая модель и выходило неестественно. Фраза попадает в инструкции сессии (`assistant/persona.ts`, `greetingRule`, «скажи ровно»); с `GREETING=off` действует короткое запасное правило; на уровне близости «Вовлечённая» ядро добавляет к нему одну открытую нить. Слать из ядра при открытии sideband нельзя: Live исполняет просьбу только при уже идущем входном звуке, и в живом звонке 22.09.2026 приветствие из ядра откладывалось до первой реплики пользователя (транскрипт `core/data/transcripts/2026-09-22-10-54-45-*`).

### 3.1.1 Конфигурация сессии GPT-Live

Вся конфигурация сессии задаётся только ядром (`core/src/realtime/session.ts`, инструкции в `assistant/persona.ts`) при `POST /v1/live/sessions` с `transport: { type: 'webrtc', sdp }`; клиент передаёт лишь голос и список инструментов телефона заголовками. Переход с `gpt-realtime-2.1` на `gpt-live-1` сделан 22.09.2026: у Realtime детектор речи стоял в аудиотракте и любой шорох обрывал ответ, у Live детектора нет, модель слушает и говорит одновременно. Текущие решения:

- `instructions` голосовой модели: задача и формат (коротко, без историй и встречных вопросов), правило полного дуплекса (замолчать, когда говорит пользователь, не реагировать на шумы), правило делегирования, приветствие, секция памяти. Легенда (ВОЛНА как Вычислительный Оркестр Логических Нейронных Агентов, конструктор Андрей, НИИ Эфирной Кибернетики в мире, где Союз не распался; решение владельца 22.09.2026) в инструкции не входит: она лежит в инструменте бэкенда `about_wave` (`assistant/tools/about-wave.ts`), а в ядре только строка «есть история, бери её у бэкенда по вопросу о себе, пересказывай одной-двумя фразами, стиль не меняй». Кто на связи, модель узнаёт из памяти, где в перспективе записано, что владелец и есть создатель. Причина: свободные атмосферные описания раньше модель воспринимала как задание и уходила в выдуманные рассказы, поэтому тест запрещает в инструкциях «товарищ» и «лаборатория» как маркеры стилизации.
- `delegation: { type: 'client' }`, единственный режим с 23.09.2026 (решение владельца; до этого по умолчанию был `delegation.responses` с бэкенд-моделью OpenAI `gpt-5.6-luna`, `BACKEND_REASONING`, `BACKEND_SERVICE_TIER` и встроенным `web_search`, а клиентский режим был экспериментом `DELEGATION=client`). Голосовая модель инструментов не зовёт и их определений не получает, только имена в инструкциях. Live присылает `session.delegation.created`, ядро (`delegation/client.ts`) отвечает само: Jev одним запросом выбирает быстрый инструмент, техкарту (с 25.09.2026 вместо набора: встроенные `core/skills/*`, свои и из плагинов, `allowed-tools` и `metadata.tier`), класс задачи, недостающее и согласие на предложенную работу; отвечает модель этого класса (Gemini 3.5 Flash Lite через OpenRouter / Luna 5.6 напрямую через Responses API OpenAI с 29.09.2026) только с инструментами техкарты, её текстом и инструкциями `buildBackendInstructions`, либо ядро само (быстрый путь, вопрос о недостающем, запуск работы после «да») ([tools-routing.md](tools-routing.md#техкарта--единица-маршрута-25092026)), ответ через `session.commentary.append`. Поиск: инструмент ядра `web_search` (`CLIENT_SEARCH_MODEL` с плагином OpenRouter `web`, выключается `WEB_SEARCH=off`). Без `OPEN_ROUTER_API_KEY` `/session` отвечает 503 до обращения к OpenAI ([core.md, 4h](core.md#4h-клиентское-делегирование)).
- Консоль ядра (`console/`, [core.md, 4k](core.md#4k-консоль-ядра)) может ответить на делегирование вместо автомата: `ClientDelegate` после ожидания хвоста спрашивает её `DelegationGate`. Без консоли (`CONSOLE=off`) поведение прежнее.
- Учёт расходов (`usage/`, [core.md, 4o](core.md#4o-учёт-расходов)): клиенты моделей пишут запись на каждый ответ, секунды GPT-Live записывает участник sideband `voiceUsage`; id звонка приходит из контекста (`usageScope`), участники sideband обёрнуты `scopedListener`. Консоль только читает учёт.
- Инструменты телефона приложение объявляет заголовком `X-Device-Tools` (только те, чьё разрешение уже дано), и только их имена попадают в инструкции; вызовы идут через очередь ядра: телефон держит долгий опрос `/device-tools` (`DeviceToolRelay`) и исполняет их `DeviceToolRunner`. Путь через data channel (`response.event` → `sendToolOutput`) удалён вместе с режимом Responses.
- Транскрипция встроена: `session.input_transcript.delta` и `session.output_transcript.delta` идут в sideband и на телефон; отдельная модель транскрипции не нужна.
- «Умность» задаётся моделями делегирования (`CLIENT_MODEL_SIMPLE`, `CLIENT_MODEL_STANDARD`, `CLIENT_SEARCH_MODEL`) и маршрутом Jev (`JEV_ROUTE_THRESHOLD`); у самой `gpt-live-1` настройки рассуждений нет. Каждый звонок пишет тайминги событий в `core/data/metrics/`, `npm run metrics` сравнивает настройки ([core.md, 4f](core.md#4f-замеры-задержек)).
- Решение Live «делегировать ли» не настраивается (только промптом). Jev (TypeSafe AI) по стенограмме угадывает прощание и заранее взводит завершение звонка ([core.md, 4g](core.md#4g-jev-раннее-завершение)).
- Голоса Live другие (`LIVE_VOICES`, по умолчанию `meridian`); прежний выбор `marin` в UserDefaults молча заменяется умолчанием. Русское произношение голосов в документации не описано и проверяется на телефоне.

### 3.2 Запуск звонка

| Источник | Путь | Особенность |
|---|---|---|
| Кнопка | `CallView → call.start(source: "Приложение")` | Запрашивает микрофон, если статус `undetermined` и приложение активно |
| Siri (SiriKit) | Расширение → `continueInApp` → `NSUserActivity` с `INStartCallIntent` → `CallAssistantApp.handleCallActivity → call.requestSystemCall()` | Работает с заблокированного экрана, не ждёт foreground |
| Команды / URL | `callassistant://call → call.requestShortcutCall()` | Откладывается до `didBecomeActive`, устаревает через 15 с |
| Демо | `SettingsView → call.preview()` | Без микрофона, сети и CallKit; фаза сразу `listening` |

`start` вызывает `SystemCallService.requestStart(id)`. На устройстве это `CXStartCallAction`; когда CallKit готов, сервис спрашивает координатор через `systemCallShouldStart(id)`, тот настраивает аудиосессию и начинает соединение, аудио включается в `systemCallDidActivateAudio`. `SimulatorCallService` делает те же вызовы делегата сразу и активирует аудиосессию напрямую. Таймаут соединения 35 с. Завершение всегда сначала освобождает микрофон и сеть (`cleanup`), потом отправляет `.ended` и просит систему завершить звонок.

### 3.3 Аудиомаршруты

`AudioRouting` реагирует на смену маршрута и датчик приближения: если выход встроенный, включает громкую связь, кроме случая, когда телефон у уха; гарнитуры, Bluetooth, USB и AirPlay не трогает. Ручного выбора динамика и аудиовхода с 22.09.2026 нет: на экране звонка только микрофон, завершение и стенограмма. Координатор получает `onRouteChanged`, `onWarning`, `onFatal` и переводит их в события.

### 3.4 Интерфейс

`CallScreen` рисует `CallState` и словарь `CallCopy`, команды уходят через `CallActions`; `CallView` только связывает экран с координатором и листами. Подзаголовок всегда показывает `state.status`: это строка, которую проверяют UI-тесты. Статус в звонке односложный с иконкой (`CallCopy.statusSymbol`). Знак `WaveMark` (272 pt в звонке, плоская тень, волна сглажена квадратичными кривыми; пока Волна думает, по кольцу бежит короткая горячая дуга из его же ламп, оборот за 4 с, `ThinkingArc`, с 26.09.2026 вместо лампы-точки и кругов от диска, [холст call-orb](design/canvas/call-orb), доска «Б′») получает измеренный уровень голоса (`CallCoordinator.voiceLevel`, из статистики WebRTC: `media-source` для микрофона, `inbound-rtp` для Волны) и падает на синтетическую огибающую, когда уровня нет (демо, симулятор). Анимация через `TimelineView` 30 кадров, Reduce Motion уважается. Палитра переключается между «Бакелитом и лампой» и «чёрным бакелитом» по системной настройке.

Главный экран (с 26.09.2026, [холст home-idle](design/canvas/home-idle), доски «Д» и «В»). В покое знака нет: между заголовком и кнопкой `HomeList` показывает все разговоры (с 26.09.2026 без предела в шесть строк; с 27.09.2026 прокручивается вся страница, а не карточка, [холст home-scroll](design/canvas/home-scroll), доски «Б» и «В»: `HomeTalks` в `ScrollView` экрана, заголовок уезжает под верхнюю строку, в ней появляется «Разговоры» с мягкой тенью, а после 60 pt прокрутки `CallKey(folded:)` складывается в круглую клавишу справа; в звонке, в «Работе» и до первого разговора страница не прокручивается; строки `LazyVStack`; по нажатию `CallRecordSheet` со стенограммой; заголовок сначала первая просьба владельца, затем название по смыслу от ядра, `POST /calls/title`) или «Работу» (вопросы исполнителя, идущие и ждущие задания, напоминания на сегодня, законченное за сутки); что именно, выбирается в настройках, группа «Главный экран» (`HomePreferences`, UserDefaults `homeMode`). Пока разговоров нет, вместо списка `EmptyHome` ([холст home-empty](design/canvas/home-empty), доска «Г»): значок-мачта, «Первый выход в эфир» и волнистая стрелка, которая раз в 2,4 с пружинит к кнопке; в «Работе» без заданий тот же экран с «Эфир свободен». Посмотреть его, ничего не удаляя, можно тумблером «Главный экран с нуля» в группе «Для разработки» (`HomePreferences.showsFirstRun`). Строки разговоров при нажатии утапливаются мягкой пилюлей, как клавиша настроек (`KeyPressStyle`). Знак виден, пока `active` или `failed`. Красная клавиша одна на оба состояния (`CallKey`): при звонке капсула «Позвонить Волне» сжимается в круглую «положить трубку», знак вырастает из неё (переход `FromKey` по измеренным центрам клавиши и знака) и зажигает кольцо лампа за лампой за 1,3 с (`RingLamps.warmup`); после звонка знак уходит обратно в клавишу, затем она расширяется, список возвращается, новый разговор въезжает сверху. С Reduce Motion только затухание. Проверено в симуляторе; в симуляторе рост знака на 2–3 с замирает, пока поднимаются звонок и аудиосессия, на iPhone не проверено.

## 4. Границы модулей

Структура выше реализована. Цель границ: поведение проверяемо без CallKit и WebRTC, новые функции не растят один файл. Пути ниже внутри `ios/`.

```
CallAssistant/
  App/            Точка входа, сцена, сборка зависимостей (AppContainer)
  Domain/Call/    Чистая модель звонка без UIKit и WebRTC:
                    CallPhase, CallState (снимок для UI), CallEvent (входные события), CallReducer (переходы)
                    CallCopy (все тексты фаз, заголовков и статусов в одном месте)
  Services/       Протоколы и реализации побочных эффектов:
                    RealtimeTransport      сейчас RealtimeClient
                    SystemCallService      CallKit на устройстве; SimulatorCallService в симуляторе
                    AudioRouting           аудиосессия, маршруты, датчик приближения
                    RingbackPlayer         звук ожидания до ответа Волны (шум эфира и «тин-тин»)
                    Permissions            микрофон, Siri, напоминания, календарь, контакты (статус и запрос)
                    DeviceTools/           DeviceToolContract (имена, аргументы, результаты; зеркало core/…/device.ts),
                                           DeviceToolStore (протокол; SystemDeviceToolStore поверх EventKit и Contacts),
                                           DeviceToolRunner (разбор function_call, исполнение, JSON для модели)
                    SettingsStore          UserDefaults + Keychain (сейчас ConnectionSettings)
                    Diagnostics            сейчас CallLaunchDiagnostics
  Calling/        CallCoordinator как оркестратор: принимает команды, вызывает сервисы, прогоняет события через CallReducer, публикует CallState
  Siri/           SiriInvocation, разбор NSUserActivity, словарь
  UI/
    Theme/        токены
    Components/   переиспользуемые элементы
    Screens/Call, Screens/Settings, Screens/Voice, Sheets/
Shared/           Код, общий с расширением (WaveContact, диагностика)
Tests/
  Unit/           CallReducerTests, CallCopyTests, ConnectionSettingsTests (новый таргет без симулятора UI)
  UI/             существующие сценарии и DesignScreenshots
```

### 4.1 Границы и правила зависимостей

- `Domain` не импортирует UIKit, CallKit, WebRTC, Intents. Только Foundation.
- `Services` знают о фреймворках, но не знают о SwiftUI и не хранят состояние звонка.
- `Calling/CallCoordinator` единственный, кто соединяет `Domain` и `Services`. Он `@MainActor`.
- `UI` зависит только от `CallState`, `CallCopy` и команд координатора. Экран не решает, что значит фаза, он рисует то, что описано в `CallCopy` и дизайн-системе.
- `Shared` не зависит ни от чего внутри приложения: его компилирует и расширение.

### 4.2 Почему так

- **Редьюсер вместо `switch` внутри колбэков.** Чистая функция `reduce(state, event) -> state` тестируется без симулятора и делает новые фазы (например, «инструмент выполняется») безопасными.
- **Протоколы для CallKit и WebRTC.** `SystemCallService` и `RealtimeTransport` подменяются в тестах; `#if targetEnvironment(simulator)` остался только в `AppContainer`.
- **Тексты в одном месте.** `CallCopy` держит фразы фаз, ошибок координатора и подписей; unit-тест проверяет строки, на которые опираются UI-тесты.
- **Снимок состояния для UI.** `CallState` как `struct` вместо набора `@Published` полей исключает промежуточные перерисовки, а превью экранов тривиальны: `CallScreen(state: .preview(.speaking), …)`.

### 4.3 Что не меняем

- Схему взаимодействия с ядром: `POST /session` с `application/sdp`, заголовок `X-Realtime-Voice`, `Authorization: Bearer`.
- Поведение CallKit, аудиосессии и очередь запусков от Siri. Это проверено на iPhone и описано в [расследовании Siri](siri-investigation.md); переносить код нужно один в один.
- Идентификаторы доступности: `settings, callStatus, callError, mute, endCall, startCall, voicePicker, serverURL, connectionResult, preview, checkConnection, memory, memoryLevel.<уровень>, memoryProfile, memoryList, memoryThreads, memoryCards.<группа>, memoryCard.<id>, forgetCard, forgetAll, debugMode, memoryTechCards, techCard.<id>, techCardRules, deleteTechCard, memoryPersona, personaHistory, personaReset, homeList, homeCall.<n>, homeMode.<talks|work>`.

## 5. Потоки данных

### Старт по кнопке (устройство)

```
CallScreen → CallActions.start → CallCoordinator.start
  → ConnectionSettings.sessionURL (валидация)   ошибка → throw, экран показывает localError
  → dispatch(.startRequested)                    phase connecting
  → Permissions.ensureMicrophone                 отказ → finish(.failed)
  → SystemCallService.requestStart(id)           CallKit CXStartCallAction
  ← systemCallShouldStart(id)                    AudioRouting.configureSession, begin; RealtimeTransport.connect
  ← systemCallDidActivateAudio                   AudioRouting.sessionDidActivate → RTC audio on; RingbackPlayer.start (звук ожидания)
  ← transport .ready (session.started)           dispatch(.sessionReady): phase connecting, linkReady; опрос подтверждений, реле инструментов, GreetingGate
  → через 0,5 с после активации аудио           transport.requestGreeting(); повтор через 4 с тишины
  ← первый голос Волны / фраза владельца / 4 с тишины после повтора
                                                 RingbackPlayer.stop; dispatch(.answered): phase listening, startedAt, connectionTime; reportConnected (CallKit + INInteraction)
```

Звук ожидания вместо гудков (с 26.09.2026, одобрен владельцем): пока исходящий звонок в фазе `connecting`, `RingbackPlayer` крутит 4-секундную петлю (`Domain/Call/Ringback`, синтез в коде, без файла): тихий шум эфира без перерыва (`hissLevel` 0,12: первые 0,45 на iPhone были слишком громкими) и в начале каждого круга мягкий «тин-тин» 523 Гц, чистый тон с подъездом на ноту и долгим затуханием, эхо через 0,35 с (вариант B из [design/sounds](design/sounds/README.md)). `AVAudioPlayer` в той же аудиосессии поверх WebRTC, громкость 0,18 (0,45 на iPhone было слишком громко). Начинается по `systemCallDidActivateAudio` с шума за 0,6 с до первого «тин-тин» (из тишины до 40 % громкости), потом за 8 с (два круга) нарастает до полной. На ответе (`didAnswer`, `stop(fade: true)`) плавно гаснет за 1 с под первым словом Волны; при отбое, ошибке и деактивации аудио (`cleanup`) обрывается за 30 мс. Микрофон открывается сразу в обоих случаях. Перезвон Волны (`callbackTask`) и демо без звука (`Ringback.shouldRing`). На 1,5 с «тин-тин» координатор выключает дорожку микрофона (`transport.setMuted`), чтобы модель не приняла его за голос владельца; под одним шумом микрофон открыт, так что входной звук течёт и фраза владельца отвечает звонок. Приветствие ради звука почти не задерживается: если просьба поздороваться выпала на «тин-тин», телефон ждёт его конца (до 1,5 с) и шлёт её при открытом микрофоне. Live исполняет просьбу только при идущем звуке с микрофона, а повтор через 4 с совпадал с циклом звука: 26.09.2026 два звонка подряд остались без приветствия, обе просьбы попали на выключенный микрофон. Первый вариант (гудки 425 Гц) и «настройка на станцию» со свистом отвергнуты владельцем.

Музыка ожидания (эксперимент 26.09.2026, в настройках «Музыка в ожидании», по умолчанию выключена): пока идёт работа, начатая в этом звонке, и оба молчат `WaitMusic.quiet` (2,5 с), телефон тихо играет одну из трёх своих мелодий без слов (`Domain/Call/WaitTunes`: электропиано, пэды с колокольчиками, маримба; синтез в коде по кругу, так что стык петли бесшовный; следующий звонок берёт следующую). Какие работы идут, ядро отдаёт в каждом ответе опроса `/device-tools` (`working`), и опрос просыпается при каждом изменении задания; первый опрос звонка идёт без ожидания, его список — работы, начатые до звонка, они музыку не включают. Решение `WaitMusic` чистое, координатор спрашивает его на каждом тике уровней. Голос Волны (уровень входящего звука и её стенограмма) гасит музыку за 0,35 с, после тишины она продолжается с того же места. Микрофон слышит музыку, поэтому, пока она играет, владелец считается говорящим только по стенограмме модели, а не по уровню: иначе утечка гасила бы музыку, тишина включала бы её снова. Микрофон не выключается. `WaitMusicPlayer` — такой же `AVAudioPlayer` в аудиосессии звонка, как звук ожидания, громкость 0,07 (владелец просил тихо, чтобы не мешала). Приложение шлёт `X-Wait-Music: on`, и голосовая модель узнаёт, что музыка не пользователь. Не проверено на iPhone: утечка в микрофон на громкой связи и реакция GPT-Live на музыку.

### Перезвон Волны (фоновое задание, VoIP-пуш)

```
ядро: TaskRunner готов → TaskDelivery: идёт звонок? заметка в звонок : callback call → APNs VoIP { task, title }
PushRegistration (PKPushRegistry, main queue) → CallCoordinator.incomingCallback(push, completion)
  → dispatch(.startRequested(source: CallCopy.callbackSource))   phase connecting; iOS требует отчёт CallKit на каждый VoIP-пуш
  → SystemCallService.reportIncoming(id)         CallKit reportNewIncomingCall, звонит «Волна»; 40 с без ответа → reportUnanswered
  ← CXAnswerCallAction → systemCallShouldStart(id)   дальше как при старте по кнопке
  → RealtimeTransport.connect(…, callbackTask)   заголовок X-Callback-Task: ядро кладёт итог в инструкции вместо правила приветствия;
                                                 requestGreeting просит начать с итогов (callbackOpeningInstruction)
```

Перезвон в назначенное время (`callbacks/`, `callback_schedule`) идёт тем же путём: `CallbackScheduler` в назначенный момент шлёт VoIP `{ task: <id перезвона>, title }`, телефон возвращает id в `X-Callback-Task`, ядро ищет его сначала среди перезвонов и начинает звонок с напоминания. Приложение не различает эти два вида перезвона.

Повторяющиеся задания (`schedules/`, `schedule_create`) новых путей не заводят: в срок `ScheduleScheduler` ставит задание «Работы» в `TaskRunner` (итог через `TaskDelivery`) или разовый перезвон в `CallbackStore` (звонок через `CallbackScheduler`). Создание только после «да» через `offer_work`. Устройство: [core.md, 4p](core.md#4p-повторяющиеся-задания).

Токены PushKit и уведомлений приложение отправляет на `POST /push/register` при каждом запуске. Устройство ядра описано в [core.md, 4i](core.md#4i-фоновые-задания-и-перезвон-волны).

### «Штурвал» вне ядра

С 21.10.2026 «Узел», Helm MCP (`/mcp` для Claude владельца), уведомления и Live Activity мобильного «Штурвала» и его диктовка (`/helm`) живут в helm-cloud, отдельном сервисе того же проекта Railway. Ядро держит только «Работу» (`helm/`, `work-sync/`) и ходит к «Узлу» через helm-cloud своим токеном по внутренней сети. Устройство: README и `docs/` репозитория helm-cloud.

### События во время разговора

```
data channel → RealtimeClient.handler(.message) → CallCoordinator.handle → dispatch(CallEvent) → CallReducer → state
статистика WebRTC 10 Гц → .level → SpeechActivity (кто говорит) → CallEvent; и → CallCoordinator.voiceLevel → WaveMark
CallView наблюдает state → CallScreen → WaveMark.State, StatusPill, subtitle
```

### Инструменты телефона

```
модель делегирования зовёт инструмент телефона → DeviceBroker (ядро) кладёт вызов в очередь
CallCoordinator.startDeviceToolRelay → DeviceToolRelay GET /device-tools?wait=25000 → DeviceToolRelay.toolCall   только имена из DeviceToolName
  → DeviceToolRunner.run   проверка разрешения → декодирование аргументов → DeviceToolStore
  → POST /device-tools/:id { output }                       не забран за 15 с → device_unavailable; забран без ответа → device_timeout
ошибки → { error: permission_denied | invalid_arguments | not_found | ambiguous | tool_failed }   модель озвучивает сбой
```

Разрешения запрашиваются только из «Настройки → Разрешения»: во время звонка с блокировки системный запрос некому нажать. Без разрешения инструмент не объявляется, и модель по инструкции говорит, что доступ включается в настройках.

### Подтверждения с телефона

Удалены 05.10.2026 (решение владельца). С 27.09.2026 у них не было источника: маршрут `/confirmations` ушёл из ядра вместе с Пультом, а телефон в звонке всё ещё опрашивал его раз в 1,5 с и получал 404. Карточка (`ConfirmationCard`, `ConfirmationRequest`, `ConfirmationClient`, события `confirmation*` в `CallReducer`) удалена. Разрешения агентам теперь даёт окно или мобильное приложение «Штурвала» (`helm-cloud/docs/relay.md`, раздел 6); Волна их по-прежнему не выдаёт ни голосом, ни через «Узел». Как было устроено: история git до 05.10.2026 и [design/volna-confirm.html](design/volna-confirm.html).

### Вопросы сессий Claude голосом

Убраны 26.09.2026 вместе с `agents_answer` и `SessionQuestionWatch`: код идёт в T3 Code, вопросы агента T3 Волна задаёт через `work_answer` ([core.md, 4l](core.md#4l-штурвал-работа-в-тредах)).

Правило без эвристик: вопрос держится, только пока ядро явно сообщает о звонке опросом с `listen=1`. Это ответы на вопросы, а не доступ: разрешения (`PermissionRequest`) по-прежнему только кнопкой. Проверено 23.09.2026 без звонка ([mac-agent-hub.md, 3.5](mac-agent-hub.md#35-телефон-remote-control-и-вопросы-сессий-проверено-23092026-claude-code-21278)).

### Один список работы («Штурвал»)

```
«Штурвал» (shell раз в 10/60 с) ─┐
tasks.json (задания Волны) ──────┴→ WorkSync (work-sync/, в памяти, только чтение)
     → GET /work (телефон, после доски этапа 3) · tasks_list (голос) · заметка в звонок о вопросе собственного треда
голос → work_stop / work_send / work_answer (после пересказа и «да») → dispatch в «Штурвал»; статус меняет только следующий снимок
перезапуск ядра → TaskStore оставляет задания с тредом running → TaskRunner.resume → helmWorker опрашивает тот же тред
```

Задание Волны связано с тредом только по `helmThread`, id треда пишется в задание до `thread.create` (`helmPending`). Устройство и статусы: [core.md, 4n](core.md#4n-один-список-работы-задания-волны-и-треды-штурвала), план и решения владельца: [task-sync.md](task-sync.md).

### Завершение и ошибки

```
end() | transport .failure | таймаут 35 с | AudioRouting.onFatal | systemCallTimedOut
  → cleanup(): отменить задачи, transport.close, audio.end, voiceLevel = nil
  → dispatch(.ended | .failed(message))
  → SystemCallService.requestEnd | reportFailed (CallKit CXEndCallAction / reportCall; симулятор деактивирует сессию)
```

## 6. Потоки и акторы

- Всё, что публикуется в UI, живёт на `@MainActor`: `CallCoordinator`, `RealtimeClient`, `SiriInvocation`.
- Делегаты WebRTC и CallKit приходят на произвольных очередях и помечены `nonisolated`; каждый переходит на главный актор через `Task { @MainActor in … }` и проверяет, что объект всё ещё актуален (`self.peer === peerConnection`, `callID == action.callUUID`).
- Гонки при перезапуске защищены поколением: `RealtimeClient.generation` и `CallCoordinator.callID`. Любая асинхронная ветка проверяет их, а редьюсер дополнительно отбрасывает события разговора вне `connected`.
- `SWIFT_STRICT_CONCURRENCY = targeted`. Новый код пишем так, чтобы пройти `complete`.

## 7. Безопасность и приватность

| Инвариант | Где обеспечивается |
|---|---|
| Ключ OpenAI только в ядре | `core/.env`, `.gitignore`, клиент не имеет поля для ключа |
| Токен ядра в Keychain с доступом после первой разблокировки | `ConnectionSettings.saveToken` |
| Только HTTPS вне локальной сети (http допускается на loopback, `*.local` и частные IPv4, с 25.09.2026 для прямого подключения к Mac в той же Wi-Fi; ядро вне localhost только с `BRIDGE_TOKEN`) | `ConnectionSettings.sessionURL`, `isLocalNetworkHost`, `configureFromDevelopmentEnvironment`, `scripts/configure-device.py`, проверка HOST в `core/src/config.ts` |
| Ядро не отвечает браузерам | Заголовок `Origin` → 403 на всех путях (`http/guards.ts`) |
| Консоль ядра только на этом Mac | Отдельный сервер на `127.0.0.1:25452`, ngrok на него не смотрит; `Host` только `127.0.0.1`/`localhost`, меняющие запросы только с `Origin` консоли (`console/routes.ts`) |
| История консоли содержит текст разговора и лежит только на Mac | `MEMORY_DIR/console`, последние 30 звонков (`console/store.ts`); в лог и замеры текст не попадает |
| Лимиты: 10 попыток в минуту с адреса, 2 одновременных, SDP ≤ 64 КБ, таймаут 20 с | `http/guards.ts`, `http/session-route.ts` |
| Ошибки OpenAI не пробрасываются телом | Таблица подсказок в `http/session-route.ts` |
| Инструменты не видят ключей, SDP и текста; их ошибки уходят модели без текста исключения | `ToolContext`, `ToolRegistry.call`, `DeviceToolRunner.run` |
| Инструменты телефона исполняет только телефон, ровно один исполнитель на имя; аргументы и результаты не логируются ни в ядре, ни в диагностике | `ToolRegistry.forDevice/runsOnDevice`, `attachSideband`, `CallCoordinator.runDeviceTools` |
| Решения, открывающие доступ (разрешения агентам), Волна не принимает: ни голосом, ни через «Узел» | У модели нет инструмента подтверждения; в белом списке «Узла» нет ответов на разрешения; разрешения даются в «Штурвале» |
| Контакты не выгружаются: `find_contact` отдаёт до трёх совпадений, только имя, адреса и телефоны | `SystemDeviceToolStore.findContacts` |
| Поиск в интернете идёт через ключ в ядре; телефон запросов к OpenAI не делает | `tools/web-search.ts` |
| На телефоне аудио не пишется на диск; текст только стенограммы последних 1000 разговоров, для главного экрана | `CallHistoryStore` (`calls.json`, защита до первой разблокировки, в резервную копию iCloud попадает как данные приложения); `CallLaunchDiagnostics` пишет только имена стадий |
| Память хранится только в ядре и только по уровню близости | `MemoryService`: транскрипция входа и извлечение включаются на уровнях «Замечает сама» и «Вовлечённая»; на «Холодной» инструменты памяти и секция памяти отсутствуют в сессии; чувствительные темы отбрасываются без `allowSensitive` |
| Замеры не содержат текста разговора и аргументов инструментов | `telemetry/trace.ts`: типы событий, имена инструментов, тайминги, длины, токены |
| Учёт расходов не содержит текста и ключей; ключ администратора OpenAI только читает счёт | `usage/ledger.ts`: служба, назначение, модель, id звонка, токены, секунды, цена; `usage/billing.ts`: только `GET` Costs API, ошибка без тела и ключа |
| Стенограмма уходит третьей стороне только для делегирования, предвыборки и заголовка разговора | `jev/`, `delegation/`: реплики звонка в модели OpenRouter при каждом делегировании, последние реплики в `api.typesafe.ai` или OpenRouter (Jev); после звонка первые 6000 знаков в модель класса `standard` за заголовком (`http/call-title-routes.ts`, ядро не хранит и не логирует); ключи в `core/.env` |
| Правила владельца в техкартах пишет только владелец голосом (новую техкарту по его просьбе пишет агент со skill-creator, [skills.md, 8](skills.md#8-новая-техкарта-голосом)); личный слой характера меняет только пересмотр после звонков, не просьба в разговоре; на уровне «Холодная» нет ни того, ни другого | `skills/tools.ts` (техкарт нет в извлечении и «сне»), `persona/review.ts`, `http/session-route.ts` |
| Большая работа (фоновое задание, новый чат или тред агента, новая техкарта) запускается только после «да» пользователя на вопрос с планом «<что сделаю>. Сделать?». Исключение с 26.09.2026: задание, которое только смотрит (`readOnly`, только `work_start`), ядро запускает сразу, дописав исполнителю запрет что-либо менять | Паспорт `startsWork`: модель таких инструментов не видит и зовёт `offer_work`, запускает ядро (`delegation/client.ts`, `READ_ONLY_STARTS`) |
| Плагины с MCP-серверами включает только владелец на Mac; изменённый `.mcp.json` требует нового включения; серверам не передаются секреты ядра, stdio-серверы получают урезанное окружение | `plugins-cli.ts enable`, `plugins/store.ts` (отпечаток), `plugins/format.ts` (`BRIDGE_SECRETS`), `plugins/runtime.ts` |
| Токен «Штурвала» только на Mac (`core/.env` или `.env` «Узла»), не в логе и не в облаке; облачное ядро знает только `HELM_INTERNAL_TOKEN` к helm-cloud; «Узел» пропускает только белый список запросов и RPC-команд, ответ на заявку только с `answers`, решения по разрешению (`decision`) и `full-access` не проходят; разрешения агенту голосом не даются, инструмента для них нет | `config.ts`, `helm/client.ts`, `helm/worker.ts`, `relay/link.ts` ([core.md, 4l](core.md#4l-штурвал-работа-в-тредах)) |
| Собственные треды владельца в «Штурвале» ядро только читает; наружу (телефон по токену ядра, голос) идут заголовок, проект, статус и вид ожидания, без сообщений, вопросов, хода и итогов; остановка хода и сообщение в такой тред только по просьбе с пересказом и «да» | `work-sync/sync.ts` (без `dispatch`, тест), `http/work-routes.ts`, `work_stop`/`work_send` в `helm/tools.ts` ([task-sync.md](task-sync.md)) |
| Скрипты из техкарт-скиллов ядро не запускает; файлы скилла читаются только внутри его папки | `skills/store.ts` (`readFile`), [skills.md](skills.md) |
| Транскрипты для извлечения памяти, «сна» и пересмотра характера уходят только моделям памяти через OpenRouter (с 25.09.2026 Anthropic: `MEMORY_MODEL`, `MEMORY_DEEP_MODEL`; до этого OpenAI), как и реплики звонка при делегировании | `memory/extractor.ts` и `persona/review.ts` через `askStructured` |
| Лог ядра не содержит текстов памяти | `log.ts`: только счётчики операций и имена событий |
| Микрофон освобождается при любом завершении | `cleanup()` вызывается до смены фазы |

Публичный запуск потребует пользовательской аутентификации, квот на пользователя и управления секретами. Это осознанно не сделано: прототип для одного человека.

## 8. Дизайн-система в коде

Спецификация: [docs/design/volna-design-system.html](design/volna-design-system.html). Соответствие в коде:

| В спецификации | В коде |
|---|---|
| Токены цвета, тени, радиусы, роли шрифтов | `UI/Theme/WaveTheme.swift` (`Volna.Palette`, `Volna.Fonts`, `Volna.Radius`, `raised()`, `pressed(in:)`) |
| WaveMark и его состояния | `UI/Components/WaveMark.swift` (`WaveMark.State`, `WaveShape`) |
| StatusPill, Lamp, SignalButton, RaisedButton, QuietButton, RoundControl, EndCallButton, ErrorCard, AnswerCard, SiriCard, SelectableRow, PressedField, SettingsGroup | `UI/Components/WaveComponents.swift` |
| Словарь состояний | `CallView.pillText / pillLamp / title` и `CallCoordinator.status` (переедут в `CallCopy`) |

Правила: один красный элемент действия на экран (знак не считается); выбранное состояние показывать вдавливанием, а не цветом; лампа горит только при реальной активности; тёмное стекло только для текста Волны; новые экраны без прокрутки на iPhone SE при Dynamic Type до 1.35×.

Известная ловушка: у `Button` со стилем `.plain` зона нажатия равна только непрозрачному содержимому. Строкам и карточкам нужен `.contentShape(...)`, иначе тап по пустой части строки не срабатывает и XCUITest промахивается.

## 9. Тестирование

| Уровень | Что | Как запускать |
|---|---|---|
| Ядро | 48 тестов: авторизация, браузеры, SDP, лимиты, VAD, голоса, ошибки upstream, инструменты и sideband, конфигурация, память (хранилище, контекст, извлечение, инструменты, REST, сквозной звонок) | `cd core && npm test`, типы `npm run typecheck` |
| UI (симулятор) | 4 теста: демо-цикл, запрет HTTP, сохранение голоса, снимки экранов | `xcodebuild … test` с подписью для симулятора; без подписи приложение падает в `SiriInvocation.init` из-за отсутствия Siri-entitlement |
| Unit | 19 тестов: `CallReducer`, `CallCopy`, `ConnectionSettings`, `MemoryModels` | Таргет `CallAssistantTests`, входит в схему; та же команда `xcodebuild … test` |
| Устройство | Матрица в [device-checklist.md](device-checklist.md) | Вручную на iPhone |

Правила: новая фаза или новый текст статуса сопровождается тестом; идентификаторы доступности не меняются без правки тестов; снимки `DesignScreenshots` сверяются с дизайн-документом после изменений интерфейса.

## 10. Как прошёл переход

План из семи шагов выполнен 21.09.2026 одним изменением, поведение сохранено, все тесты зелёные (21 в Xcode, 9 в ядре). Отличия от первоначального плана:

- `RealtimeTransport` отдаёт события через один колбэк `handler`, а не `AsyncStream`: проще отменять и подменять в тестах.
- Донат `INInteraction` переехал из координатора в `CallKitCallService.reportConnected`, потому что это интеграция с системой, а не логика звонка.
- Уровень голоса берётся из `RTCPeerConnection.statistics` (поля `audioLevel` у `media-source` и `inbound-rtp`) с опросом 10 Гц и сглаживанием, без аудиорендереров.
- Тёмная тема включена сразу по системной настройке через динамические `UIColor`.

Следующие кандидаты: вынести очередь запусков от Siri/Команд в отдельный сервис, добавить тесты координатора с заглушками `SystemCallService` и `RealtimeTransport`.

## 11. Как добавлять функции

- **Новая фаза разговора** (например, вызов инструмента): добавить в `CallPhase`, переход в `CallReducer`, тексты в `CallCopy`, состояние в `WaveMark.State`, строку в таблицу состояний дизайн-документа, unit-тест перехода.
- **Новая настройка:** поле в `SettingsStore` (UserDefaults для несекретного, Keychain для секретов), группа в `SettingsView` из `SettingsGroup/SettingsRow`, при необходимости заголовок запроса к ядру и его проверка в ядре с тестом.
- **Новый экран:** папка в `UI/Screens`, только компоненты дизайн-системы, идентификаторы доступности для тестируемых элементов, снимок в `DesignScreenshots`.
- **Изменение протокола с ядром:** сначала тест в `core/src/app.test.ts`, потом ядро, потом клиент, потом README.
- **Новая возможность ассистента:** сначала техкарта (`core/skills/<имя>/SKILL.md`: описание «когда» для Jev, `allowed-tools`, `metadata.tier`), инструменты к ней в коде или MCP-сервером в плагине ([skills.md](skills.md)).
- **Новый инструмент ассистента:** инструмент ядра по шагам из [core.md, раздел 5](core.md#5-как-добавить-инструмент), клиент не меняется. Инструмент телефона: определение с `runsOn: 'device'` в `core/src/assistant/tools/device.ts`, зеркало в `DeviceToolContract.swift`, ветка в `DeviceToolRunner` и `DeviceToolStore`, unit-тест с поддельным хранилищем; при новом системном разрешении строка в `Permissions`, `Info.plist` и группе «Разрешения» (`SettingsView.permissionsGroup`).
- **Ресурсы и файлы:** после добавления, переноса или удаления Swift-файлов запустить `ruby ios/scripts/sync-project.rb`; шрифты и каталоги регистрировать через `ios/scripts/add-design-resources.rb` и `ios/scripts/generate-project.rb`, иначе регенерация их потеряет.

## 12. Открытые вопросы и долги

- Переход на GPT-Live (22.09.2026) проверен только тестами с поддельным OpenAI и сборкой в симуляторе. На iPhone не проверены: соединение WebRTC с `/v1/live/sessions`, русская речь и голоса Live, приветствие через `GreetingGate` и начало звонка по первому слову Волны (после `session.started` и активации аудио; прежний вариант сразу по `session.started` в живых звонках 22.09.2026 срабатывал с задержкой 6–40 с или после реплики пользователя), инструменты телефона через очередь `/device-tools`, напоминание с блокировки через Siri. Матрица в [device-checklist.md](device-checklist.md).
- Фазы экрана выводятся из уровней звука (`SpeechActivity`): пороги 0.12/0.05 и окна 0.9/0.7 с подобраны без телефона; править по ощущениям на устройстве.
- У `DeviceToolRunner` нет тайм-аута исполнения: `fetchReminders` теоретически может не ответить; добавить гонку с 10 с, если проявится.
- Удаление и перенос напоминаний и событий намеренно не реализованы (дизайн, решение 2); добавлять только через подтверждение вслух.

- `SiriInvocation.init` вызывает `INPreferences.siriLanguageCode()` при первом обращении; без Siri-entitlement процесс падает. Стоит обернуть в проверку entitlement или отложить до `refresh()`.
- Уровень голоса из статистики WebRTC проверен только в сборке: на iPhone нужно убедиться, что `audioLevel` приходит для обоих направлений.
- Стилизация системных кнопок навигации (iOS 26 стекло) не совпадает с корпусом; решить при переходе на кастомную панель или оставить.
- Запуск с заблокированного экрана и аудиомаршруты на реальном iPhone проверены частично, см. чек-лист.
