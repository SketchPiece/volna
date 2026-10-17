# Контрольная проверка Siri с блокировки — 21.09.2026

**Актуальный результат:** упрощённая Zorava `tone-1` успешно начинает SiriKit/CallKit-звонок и воспроизводит сигналы без разблокировки. Пользователь подтвердил звук; журнал показывает `state=2`, `protectedData=false`, успешный CallKit request и `audio.play started=true`. Рабочая конфигурация и ограничения проверки: [TONE-TEST.md](../archive/speakerbox/TONE-TEST.md). Ниже сохранена история предыдущих, неуспешных экспериментов.

Устройство: iPhone 15 Pro Max, iOS 27. Состояние: заблокирован, без успешного Face ID. Во всех сценариях сохранять одинаковое положение телефона и подключение наушников.

## Пример Apple

Источник: https://developer.apple.com/documentation/callkit/voip-calling-with-callkit
Архив: https://docs-assets.developer.apple.com/published/8e99045a90e2/MakingAndReceivingVoIPCallsWithCallKit.zip
SHA256: 53939bdccdb27fc2477e7cd2d17219dc9d88325db3ea5e0ab53fcf33ac1a27e6
Распакован: /tmp/volna-speakerbox
Сборка: /tmp/volna-speakerbox-build

В исходной контрольной сборке логика примера не изменена; команда сборки задаёт DEVELOPMENT_TEAM для подписи. Пример имитирует соединение и не звонит реальному абоненту. Не использует API OpenAI.

## Последовательность

1. Обычный телефонный звонок через Siri с блокировки (пользователь выбирает допустимого адресата).
2. Speakerbox: открыть вручную, проверить тестовый исходящий звонок, завершить.
3. Speakerbox: проверить Siri на разблокированном устройстве.
4. Только после успешного шага 3 повторить ту же фразу с блокировки.

Фраза для английской Siri: Call [имя контакта] using Speakerbox. Проверять, что Siri выбрала именно Speakerbox.

## Результаты

- Волна: Shortcut и отдельная SiriKit-фраза требуют разблокировки (ранее подтверждено пользователем).
- Phone: ожидается ответ пользователя.
- Speakerbox: сборка успешна, установлен на устройство (bundle ID com.example.apple-samplecode.callkit-speakerbox-sample4KSA86792T); ожидается проверка Siri пользователем.

## Ограничения интерпретации

Отказ Speakerbox на разблокированном устройстве не доказывает ограничение блокировки. В текущем архиве обработчик продолжения activity находится в AppDelegate, а приложение использует SceneDelegate без обработчика continuation; это отдельный возможный дефект примера, который нужно отличать от запроса разблокировки. Сборка и установка сами по себе не подтверждают работу Siri.

## Ошибка исходного примера и диагностическая сборка

Пользователь сообщил ответ Siri на разблокированном iPhone: «Sorry there was a problem with the app». Результат обычного звонка с блокировки пока неизвестен. Отказ примера на разблокированном экране не подтверждает ограничение lock screen.

Проверка подписи: у приложения Speakerbox отсутствует com.apple.developer.siri; исходный архив содержит только watch-entitlements. Также SceneDelegate не обрабатывает continuation activity, хотя включён scene lifecycle. Третья гипотеза — extension возвращает failure из-за отсутствия personHandle.

В отдельный проект /tmp/volna-speakerbox добавлены временные DEBUG-speakerbox-siri probes: extension.handle/response, app.launch/continue, scene.connect/continue, callkit.request/result. Диагностика пишет только этапы, наличие адресата (bool), число адресатов и коды результата, без имён и номеров. Хранение: последние 40 строк в UserDefaults speakerboxSiriProbe каждого процесса. Обработчик scene.continue пока только фиксирует получение, не меняя поведение исходного примера. Исправления entitlement и маршрутизации пока не применены, чтобы сначала определить место отказа. Диагностическая сборка успешна.

## Повтор после перезагрузки Mac

Пользователь повторно получил общую ошибку Siri. Считаны defaults приложения: только app.launch и scene.connect activities=0 от ручного открытия, без scene.continue и callkit.request. Plist расширения с probe отсутствует; журнал handle не получен. Отчётов о падении Speakerbox/IntentsExtension не найдено. Точного системного кода ошибки нет.

Исходники в /tmp были удалены при перезагрузке. Оригинальный архив повторно загружен в archive/speakerbox, диагностические probes восстановлены. Следующий однофакторный эксперимент: добавлен com.apple.developer.siri в entitlement основного iOS target с автоматическим provisioning. Обработка scene activity пока не исправлена. Это диагностическая модификация примера Apple, не неизменённый эталон.

## Первый запуск и разрешения

По просьбе пользователя добавлены NSSiriUsageDescription и последовательные запросы INPreferences.requestSiriAuthorization / microphone record permission при sceneDidBecomeActive. Пока один запрос выполняется, второй не запускается. Решения системы отображаются в MainView; после отказа доступен переход в Settings. Запросы не запускают запись. Siri entitlement проверен в подписанном бинарном файле; сборка успешна. Пользователь разрешил чистую переустановку только Speakerbox. Маршрутизация activity пока остаётся диагностической, поэтому разрешения сами по себе не гарантируют исправление звонка.

## Подтверждённая причина ошибки расширения

После переустановки считан probe расширения: extension.handle contacts=1 hasHandle=false → extension.response=4 (.failure). Это прямой отказ исходного guard при отсутствии personHandle, до передачи в приложение. В приложении есть успешные ручные CallKit-транзакции code=0. Статусы разрешений ещё отсутствовали: проверка active в sceneDidBecomeActive могла срабатывать до обновления UIApplication, поэтому запросы теперь также запускаются на didBecomeActiveNotification и следующем main tick.

Для дальнейшего теста добавлен resolveContacts с единственным синтетическим Test (+12025550123, примерный номер; все звонки остаются локальной имитацией), resolveCallCapability audio и confirm ready. Заполнен ранее отсутствовавший scene continuation для тёплого и холодного запуска. Новая фраза: Call Test using Speakerbox. Повторная физическая проверка обязательна; успешная сборка не подтверждает запуск Siri с блокировки.

## Один успешный вызов, затем повторная общая ошибка

Пользователь подтвердил один успешный запуск, затем повторную ошибку. Defaults: Siri и микрофон — «Разрешено». Extension: resolveTestContact → handle contacts=1 hasHandle=true → response=2 (continueInApp). Host: scene.continue hasHandle=true state=1 → callkit.request state=1 → callkit.result code=0. Через ~14 секунд ещё одна ручная транзакция state=0/code=0 (тип действия старый probe не записывает). После успешного вызова новых extension-записей нет. Это не доказывает системный запрет: следующий сбой пока не локализован, уточняются фраза и состояние блокировки. Не менять код звонка без новых данных.

## Регистрация системных действий звонка

Добавлены NSUserActivityTypes: INStartCallIntent и INStartAudioCallIntent. Декодер activity теперь принимает оба типа; прежний аудио-intent обрабатывается как audio-only. Исправлена сигнатура fallback UIApplicationDelegate continuation, оконные обработчики тёплого и холодного старта сохранены. В диагностике scene записывается activityType для различения маршрутов. Это настройка для проверки Contacts/Recents/Siri, а не доказательство причины предыдущего нестабильного распознавания. Появление в меню Contacts и повторные Siri-запуски требуют физической проверки.

## Выбор обычного телефона вместо Speakerbox

Пользователь подтвердил, что WhatsApp через Siri работает, а Speakerbox иногда заменяется обычным телефонным звонком даже при текстовом вводе. Успех из Contacts подтверждён. Это не доказательство ограничения блокировки и не ошибка распознавания речи как такового. По Apple QA1950 добавлены явный CFBundleDisplayName=Speakerbox и INAlternativeAppNames: Speaker Box. Добавлен override handler(for:) с probe extension.dispatch для фиксации самого входа в расширение. Сборка успешна; влияние на маршрутизацию Siri требует проверки. Источник: https://developer.apple.com/library/archive/qa/qa1950/_index.html

## Distinctive test app name: Zorava

User reported Siri interpreting Speaker Box as speaker audio routing and requested a distinctive name. Renamed the test app's CFBundleDisplayName, CFBundleName, CFBundleSpokenName and visible navigation title to Zorava. Removed INAlternativeAppNames (Speaker Box). Updated permission descriptions and extension display name. Kept bundle identifiers, signing, permissions and call behavior unchanged. Test phrases: Open Zorava; Call Test using Zorava. Name recognition and calling still require device verification.

## Системная диагностика через Console.app

CLI log collect требовал root, sudo без пароля недоступен. Вместо этого через Console.app выбран Sketch iPhone, включён streaming и Info Messages, установлен фильтр speakerbox (внутренний bundle/process сохраняет старое имя после переименования в Zorava). Это локальный поток системного журнала; пользователь приглашён воспроизвести один вызов Call Test using Zorava для сопоставления с сообщениями Siri и системы. Причина маршрутизации пока не установлена.

## Первая полезная запись системной Siri

Console capture 21:03:54.249613: intelligenceflowd / AgentCanvasFoundation / PersistenceProcessor recorded SystemResponse disambiguate: "Which test would you like to call using Zorava?". Items have sourceToolId com.apple.omniSearch.SearchToolExtension.SearchTool, searchResultSource global. This establishes ambiguity resolution for Test in this captured attempt; mention of Zorava in dialogue alone does not establish successful app routing. Another assistantd message at 21:03:54.146054 has NSOSStatusErrorDomain -50 about its own audit token/bundle type, not an identified failure of the Zorava extension; do not attribute it to our app without further evidence. Streaming paused to inspect captured records.

## Регистрация app-specific контакта Test

После системной записи disambiguate для Test добавлена регистрация INVocabulary.shared().setVocabularyStrings(NSOrderedSet(array: ["Test"]), of: .contactName) после разрешения Siri, один раз на процесс. Это публикация словаря встроенного адресата, а не создание контакта в адресной книге. Probe vocabulary.test.submitted означает вызов API, не гарантирует завершение индексации или выбор приложения новой Siri. Следующий тест сохраняет прежнюю фразу Call Test using Zorava. Источник: https://developer.apple.com/documentation/sirikit/registering-custom-vocabulary-with-sirikit

## Словарь не устранил ошибку

После vocabulary.test.submitted пользователь проверил Test и Mom, обе попытки неуспешны. Console: 21:07:51 Campo распознал текст Call test using zorava как en; 21:08:05 intelligenceflowd сформировал disambiguate "Which Mom would you like to call using Zorava?" с географическими вариантами в Nigeria/Cameroon, источник omniSearch.SearchTool, global. Plist расширения по-прежнему отсутствует. Следовательно, для этих попыток нет подтверждения вызова SiriKit handler, и словарь Test не решил проблему. Уточняется способ запуска Siri (отдельный Siri AI/боковая кнопка/голос). Не считать ошибку подтверждённой несовместимостью SiriKit без сравнительного теста. Системный streaming приостановлен после чтения.

## Голос и короткая команда

Пользователь уточнил: неуспешные попытки были через Spotlight; вызов Siri голосом один раз сработал. Прежний вывод о необходимости SDK27 не доказан. Пользователь запросил короткое «позвони Зараве», предложил создание контакта. Реализован отдельный App Shortcut CallZoravaIntent с фразами Call applicationName / Talk to applicationName и ru-локализацией, без создания адресной записи и без реального телефонного номера в Contacts. Используется прежняя локальная имитация CallKit. openAppWhenRun=true, старт после активации с TTL15sec и защитой от второго звонка. Этот путь может требовать unlock и не заменяет контроль SiriKit с блокировки. Сборка успешна, голосовое распознавание короткой фразы ещё требует проверки.

## Много вопросов Siri и открытие приложения

Пользователь сравнил WhatsApp и Zorava: Zorava уточняет адресата/номер, затем открывает приложение. Это не подтверждает, что CallKit не используется, и не доказывает отсутствие Face ID при тесте с блокировки. Найдена искусственная подмена любого INPerson на Test в нашем диагностическом resolver. Убрана: существующий personHandle сохраняется; для отсутствующего используются однозначные siriMatches либо disambiguation/needsValue, без произвольного выбора номера. Синтетический адресат только для имён Test/Zorava и русских вариантов. Дополнены probes provider.start, provider.start.fulfilled, provider.audioActivated. Успешная сборка; влияние на вопросы Siri не подтверждено физическим повтором. Исходный Speakerbox остаётся имитатором, не сервисом звонков реальным контактам.
