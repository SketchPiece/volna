# Siri: проверка документации и реализации, 21 сентября 2026

Исследование исходников, последних локальных сборок, ранее снятых журналов и актуальной документации Apple. В этом проходе приложение не менялось и не переустанавливалось; новых голосовых проверок не было. Подключённый iPhone сообщает iOS 27.0, build 24A437. Apple перечисляет эту сборку как публичный релиз от 14 сентября: https://developer.apple.com/news/releases/?id=09142026a. Установлены Xcode и SDK 26.5.

## Что верно в советах на скриншотах

| Совет | Проверка |
| --- | --- |
| Снять Authentication Required в `.intentdefinition` | Идея проверки аутентификации разумна, но указан неправильный для нас файл. `INStartCallIntent` — системный SiriKit intent. Его ограничения настраиваются у Intents Extension, в Supported Intents / Authentication и соответствующих ключах Info.plist. Собственное определение этого intent создавать не нужно. |
| Не требовать разблокировки в обработчике | Оба наших обработчика уже возвращают `.ready` и `.continueInApp`, без проверки блокировки. В собранной «Волне» `IntentsRestrictedWhileLocked` пуст; в Zorava ключ отсутствует. Дополнительный запрет со стороны расширения не объявлен. |
| Использовать CallKit | Уже реализовано в обоих приложениях. Само подключение CallKit не гарантирует, что Siri правильно выберет приложение, разрешит адресата и передаст управление без разблокировки. |
| После снятия ограничения Siri сразу позвонит | Такой гарантии документация не даёт. У `INStartCallIntent` указано, что разблокировка требуется не всегда. Это отличается от гарантированного фонового исполнения любой команды. |

Источники: [настройка Intents Extension](https://developer.apple.com/documentation/sirikit/creating-an-intents-app-extension), [INStartCallIntent](https://developer.apple.com/documentation/intents/instartcallintent), [VoIP Calling](https://developer.apple.com/documentation/sirikit/voip-calling). Apple требует передавать запуск звонка основному приложению; начинать CallKit/аудио из SiriKit-расширения не следует. `.continueInApp` — предусмотренная передача управления, а не сама по себе ошибка.

## Подтверждённые свойства нашего кода

### 1. Короткие команды требуют foreground

- `ios/CallAssistant/Calling/CallIntent.swift`: `openAppWhenRun = true`, `authenticationPolicy = .alwaysAllowed`.
- `archive/speakerbox/source/Speakerbox/CallZoravaIntent.swift`: те же настройки; запуск ждёт `.active`.
- `ios/CallAssistant/App/CallAssistantApp.swift:35`: даже системный SiriKit-вызов передаётся в `requestShortcutCall`.
- `ios/CallAssistant/Calling/CallCoordinator.swift:104`: очередь не начинает звонок до `UIApplication.applicationState == .active`.

Это явная зависимость реализации от активного приложения. Она была добавлена для устранения воспроизведённого CallKit error 6 в Shortcuts. Её нельзя считать решением сценария без разблокировки. При этом её устранение уже пробовалось отдельно и не сняло запрос разблокировки; одной замены флага недостаточно.

В Zorava путь `INStartCallIntent → SceneDelegate → callManager.startCall` этой очередью не пользуется. Нельзя объяснять все его сбои foreground-ограничением короткой команды.

[Apple: openAppWhenRun](https://developer.apple.com/documentation/appintents/appintent/openappwhenrun) теперь рекомендует `supportedModes`; [alwaysAllowed](https://developer.apple.com/documentation/appintents/intentauthenticationpolicy/alwaysallowed) определяет политику аутентификации. Переписать старое свойство на новый синтаксис — не самостоятельное исправление.

### 2. Тест с Mom не имеет полноценной интеграции адресной книги

В Zorava отсутствуют `NSContactsUsageDescription`, запрос доступа через `CNContactStore`, поиск контакта по `contactIdentifier` и собственная база реальных абонентов. Вызовы остаются локальной имитацией.

`IntentsExtension/IntentHandler.swift:37` оставляет только `siriMatches` с непустым `personHandle`. Совпадение с известным идентификатором, но без готового номера, отбрасывается. Если готовых совпадений нет, возвращается `.needsValue()`. Это конкретный путь к повторным вопросам, когда запрос уже дошёл до расширения.

Apple описывает влияние доступа к Contacts на заполнение `INPerson`, рекомендует учитывать идентификаторы и совпадения Siri: [INPerson](https://developer.apple.com/documentation/intents/inperson), [рекомендации для messaging и VoIP](https://developer.apple.com/documentation/sirikit/improving-interactions-between-siri-and-your-messaging-app). Фактический статус разрешения Contacts на телефоне в этом проходе не читался. Отсутствие запроса не равно доказанному отказу пользователя.

**Это не доказывает причину карты с Mom.** В ранее снятом системном журнале варианты пришли из `com.apple.omniSearch.SearchToolExtension.SearchTool`, `global`; для тех попыток вход в наше расширение не подтверждён. Отсутствие записей расширения само по себе тоже не является полным доказательством отсутствия вызова.

### 3. Регистрация собственного адресата неполна

- В Zorava публикуется только строка `Test`; имени Zorava и стабильного идентификатора в этой публикации нет.
- В «Волне» собственный адресат создаётся только внутри `resolveContacts`, после выбора расширения системой.
- В обоих проектах отсутствуют `AppIntentVocabulary.plist` с примерами SiriKit и явные `INInteraction.donate()` после действий в приложении. Последнее означает отсутствие нашей явной публикации, а не отсутствие любой системной истории.
- `AppShortcuts.strings` есть, но это ресурс другого механизма, не замена SiriKit vocabulary.

Apple рекомендует публиковать собственные контакты через `INSpeakableString` со стабильным `vocabularyIdentifier`, совпадающим с `INPerson.customIdentifier`, и публиковать выполненные действия. Это обоснованное улучшение регистрации, но не гарантированное исправление текущей ошибки. Источники: [контакты и взаимодействия](https://developer.apple.com/documentation/sirikit/improving-interactions-between-siri-and-your-messaging-app), [словарь SiriKit](https://developer.apple.com/documentation/sirikit/registering-custom-vocabulary-with-sirikit), [распознавание имени приложения](https://developer.apple.com/library/archive/qa/qa1950/_index.html).

### 4. Новая схема Siri AI отсутствует, но совместимость не исключена

В обоих проектах нет схемы `.phone.startCall` и сущности адресата `.phone.phonePerson`. Эти API появились в iOS 27; текущий SDK 26.5 их не предоставляет. Для отдельной современной реализации нужен Xcode с SDK 27.

Важное уточнение: [инженер Apple прямо подтвердил](https://developer.apple.com/forums/thread/833920) совместимость новой Siri с большинством SiriKit-intents и рекомендовал добавлять схемы, сохраняя старую интеграцию. Поэтому утверждение «старый SDK обязательно является причиной» не подтверждено. Отдельные успешные голосовые вызовы также не согласуются с полным отсутствием поддержки старого пути.

Источники новой интеграции: [Siri AI](https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai), [phone.startCall](https://developer.apple.com/documentation/appintents/appschema/phoneintent/startcall), [phonePerson](https://developer.apple.com/documentation/appintents/appschema/phoneentity/phoneperson).

## Что дополнительно проверено

- В последних локально собранных приложениях Siri entitlement присутствует в XML-блоке подписи Mach-O; в обоих extension plist заявлен `INStartCallIntent`. Это статическая проверка содержимого, не новая проверка работы Siri на устройстве. Локальный `codesign -d --entitlements` выдал предупреждение и не распечатал блок, поэтому содержимое прочитано непосредственно из Mach-O; по этому предупреждению отдельный дефект подписи не установлен.
- В host plist обоих приложений есть `NSUserActivityTypes` для современных и старых audio-call activities, background modes `audio` и `voip`.
- `userActivity: nil` у ответа «Волны» допустим: [система создаёт activity и interaction сама](https://developer.apple.com/documentation/intents/instartcallintentresponse/init(code:useractivity:)).
- Токен «Волны» сохраняется с `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: обычная повторная блокировка после первого unlock не должна сама по себе лишать его доступности. После перезагрузки до первого unlock это иной сценарий.
- В [release notes iOS 27](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes) отмечены исправления разрешения адресатов и запуска `phone.startCall` с CallKit. Они не устанавливают причину нашего случая; современную схему мы пока вообще не используем.

## Гипотезы и проверки по приоритету

| Гипотеза | Что должно наблюдаться / что её отделит от остальных |
| --- | --- |
| Siri неправильно разрешает адресата или выбирает механизм вызова до исполнения нашего кода | При карте — системный global search, без подтверждённого `extension.dispatch` / `shortcut.request`. Сравнить один и тот же собственный адресат голосом и текстом, с метками времени. |
| Неполная публикация собственного адресата ухудшает выбор приложения | После публикации имени со стабильным ID и реального тестового взаимодействия та же фраза начинает приходить в расширение чаще. Менять только регистрацию, без очередного переименования и смены CallKit. |
| Обработчик контактов вызывает часть повторных уточнений | Перед вопросом фиксируется `extension.contacts.matches=0` либо disambiguation. Для контроля с реальным контактом нужны разрешение Contacts и корректное разрешение ID; для AI-продукта проще проверять собственного единственного адресата. |
| Система блокирует handoff уже разрешённого SiriKit-звонка | Есть `.continueInApp`, но activity не приходит в host до unlock. Если activity пришла, дальше отдельно проверяются CallKit transaction, provider.start и audio activation. |

Текущая Zorava уже существенно отличается от исходного Speakerbox. Следующий контроль должен фиксировать конфигурацию и один маршрут запуска, иначе успех нельзя связать с конкретным изменением.

## Предлагаемый следующий шаг

Сначала довести один диагностический SiriKit-путь с собственным адресатом: стабильное имя/ID, словарь и публикация фактически выполненного тестового звонка. Изолировать его от App Shortcut с похожей фразой. Успех — повторяемый вход в обработчик и запуск CallKit на разблокированном телефоне. Только затем повторить ту же команду при закрытом замке, без Face ID; положение телефона и аудиомаршрут должны быть одинаковыми.

Если после корректной регистрации новая Siri продолжает уходить в глобальный поиск, следующий независимый эксперимент — SDK 27, схема `phone.startCall`, индексируемый собственный адресат. При реализации учитывать специальные аудио-протоколы и требования к жизненному циклу: [AudioRecordingIntent](https://developer.apple.com/documentation/appintents/audiorecordingintent) отдельно требует Live Activity во время записи. Обещать результат без устройства нельзя.

Системную адресную книгу и «маму» не нужно делать зависимостью конечного AI-сценария. Создание контакта само по себе не устанавливает приложение, которым Siri обязана звонить. Пока не доказано ни что сценарий невозможен, ни что наша текущая сборка стабильно работает без разблокировки.
