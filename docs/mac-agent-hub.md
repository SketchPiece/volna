# Mac-приложение «Пульт»: клиент Волны и хаб для агентов

> **Deprecated с 26.09.2026** (решение владельца): вся работа идёт через T3 Code, Астра не нужна, Пульт не развивается. Документ оставлен как справка; синхронизация работы описана в [task-sync.md](task-sync.md). С 27.09.2026 код лежит в `archive/pult/`, скрипты сборки в `archive/pult/scripts/`.

Исследование и план от 22.09.2026. Рабочее название «Пульт» (заменить, когда владелец выберет имя). Здесь зафиксировано, какие интерфейсы у Claude Code / Claude Desktop и у Codex / ChatGPT.app реально существуют, что из них документировано, и как на этом строить приложение. Всё ниже проверено на этой машине (Claude Code 2.1.278, Codex CLI 0.155.1, Claude.app с Code-вкладкой, ChatGPT.app со встроенным Codex) 22.09.2026; версии меняются быстро, перепроверять при старте каждого этапа.

## 1. Короткий ответ

| Вопрос | Codex | Claude |
|---|---|---|
| Есть ли API создавать сессии | **Да, официальное**: `codex app-server` (JSON-RPC 2.0 по stdio / unix-сокету / WebSocket), метод `thread/start` + `turn/start` | **Да, для своих сессий**: Agent SDK, то есть процесс `claude -p --input-format stream-json --output-format stream-json`; ровно так Claude Desktop запускает свои сессии |
| Смотреть список сессий | **Да**: `thread/list` видит все треды на диске, включая созданные ChatGPT.app (фильтр `sourceKinds`) | **Да**: `claude agents --json` (документирован, стабилен) показывает все живые сессии, включая сессии Claude Desktop; история через SDK `listSessions()` / `getSessionMessages()` |
| Читать транскрипт | `thread/read`, `thread/items/list`, `thread/turns/list` | SDK `getSessionMessages()`; формат `.jsonl` внутренний |
| Писать в чужую живую сессию | `thread/resume` + `turn/start`, `turn/steer`, `codex queue --thread … --message …` | Сокет-инбокс сессии `/tmp/cc-socks/<pid>.sock` (документирован для скриптов и хуков), доставка подчиняется `crossSessionInbound` |
| Получать события живых сессий | Уведомления app-server (`item/*/delta`, `turn/completed`, запросы одобрений) | HTTP-хуки в `~/.claude/settings.json` (SessionStart, Stop, Notification, PermissionRequest…) шлют POST в наше приложение |
| API у самого десктоп-клиента | ChatGPT.app держит собственный процесс `codex app-server`; наружу не торчит, но общий демон `codex app-server daemon` предусмотрен | Claude Desktop не публикует API. Внутри своих сессий он даёт MCP-инструменты `ccd_session_mgmt` (list_sessions, send_message, get_session…); снаружи их нет. Есть недокументированная deep-link `claude://claude.ai/epitaxy/<local_id>` «открыть сессию» |

Вывод: для Codex строим на официальном app-server. Для Claude собираем хаб из четырёх документированных кирпичей (`claude agents --json`, stream-json-процесс, инбокс-сокет, хуки) и не трогаем внутренности Claude Desktop.

## 2. Что нашли: Codex

### 2.1 App-server

- Запуск: `codex app-server` (по умолчанию stdio), `--listen unix://PATH` или `ws://127.0.0.1:PORT`; для не-loopback обязательна авторизация `--ws-auth capability-token | signed-bearer-token`.
- Рукопожатие: `initialize` (clientInfo, capabilities, `optOutNotificationMethods`) → уведомление `initialized`. До него любой запрос отвечает «Not initialized».
- Схема протокола генерируется самим CLI: `codex app-server generate-json-schema --out DIR` и `generate-ts --out DIR`. В 0.155.1 — 102 клиентских метода. Ключевые:
  - треды: `thread/start`, `thread/list` (курсор, `sortKey`, `archived`, `cwd`, `searchTerm`, `sourceKinds`: cli, vscode, exec, appServer, subAgent…), `thread/loaded/list`, `thread/resume`, `thread/read`, `thread/items/list`, `thread/turns/list`, `thread/fork`, `thread/name/set`, `thread/archive`, `thread/delete`, `thread/compact/start`, `thread/goal/*`, `thread/inject_items`;
  - ходы: `turn/start` (input: text, image, localImage; cwd, model, effort, sandboxPolicy, approvalPolicy), `turn/steer` (дописать в текущий ход), `turn/interrupt`;
  - окружение: `model/list`, `account/read`, `account/rateLimits/read`, `skills/list`, `plugin/*`, `mcpServer/*`, `fs/*`, `command/exec`, `review/start`, `hooks/list`;
  - серверные запросы к клиенту (мы обязаны отвечать): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`. Ответы: accept / acceptForSession / decline / cancel;
  - поток: `turn/started`, `item/started`, `item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta`, `item/completed`, `turn/completed`, `thread/tokenUsage/updated`, `thread/queue/changed`.
- В схеме есть семейство `thread/realtime/*` (`started`, `sdp`, `transcript/delta`, `outputAudio/delta`, `item/*`): голосовой режим внутри треда по WebRTC. В документации не описан, считать экспериментом. Для Волны это потенциальный прямой путь «голос → Codex-тред», см. раздел 6.
- Перегрузка: ошибка `-32001 Server overloaded`, повторять с экспоненциальной паузой.

### 2.2 Где живут данные и процессы

- Треды: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (первая строка `session_meta`: id, cwd, originator «Codex Desktop», source), индекс `~/.codex/session_index.jsonl`, состояние в `~/.codex/*.sqlite`. Любой экземпляр app-server читает этот же диск, поэтому `thread/list` из нашего процесса видит треды ChatGPT.app.
- ChatGPT.app запускает `…/ChatGPT.app/Contents/Resources/codex app-server` как свой дочерний процесс и слушает `~/.codex/ipc/ipc.sock` (внутренний сокет приложения, не app-server). Общий демон (`~/.codex/app-server-control/app-server-control.sock`) на машине **не запущен**: `codex app-server daemon version` отвечает «failed to connect».
- Общий демон: `codex app-server daemon start|stop|restart|enable-remote-control`, `codex remote-control start|stop|pair`, `codex app-server proxy` (пробрасывает stdio в сокет демона), `codex agents` (обзор сессий на демоне), `codex --remote ws://…`. Это путь, когда нужен один процесс на всех клиентов и управление с телефона через ChatGPT mobile.
- Неизвестно и нигде не описано: что происходит, если два app-server одновременно делают `thread/resume` одного треда. Считать небезопасным до эксперимента.
- Общий app-server с ChatGPT.app (разбор 23.09.2026 по `app.asar` ChatGPT.app 26.915 и исходникам openai/codex main, живьём не проверено):
  - Переменная `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:PORT` заставляет приложение подключаться к внешнему app-server по WebSocket вместо своего stdio-процесса; `CODEX_APP_SERVER_FORCE_CLI=1` это отменяет. Путь через общий демон (`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`) в этой сборке, судя по коду, не срабатывает: для локального хоста приложение всегда передаёт `-c`-переопределение, а демон принимается только без них.
  - Уведомления треда и запросы сервера к клиенту, включая `mcpServer/elicitation/request`, уходят всем подписанным клиентам; засчитывается первый ответ, остальные получают `serverRequest/resolved`. Неотвеченные запросы пересылаются клиенту, который подписался позже. Отдельного `subscribe` нет: подписку даёт `thread/resume` на загруженном треде.
  - Следствие: при общем сервере запрос доступа к приложению появится и в окне Codex на Mac, и ответить там можно раньше телефона. Это противоречит правилу «доступ только кнопкой на телефоне» ([design/volna-confirm.html](design/volna-confirm.html)).
  - Эксперимент: `codex -c features.code_mode_host=true app-server --listen ws://127.0.0.1:4599`; владелец закрывает ChatGPT.app и открывает `open -a ChatGPT --env CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4599`; Пульт подключается к тому же адресу по WebSocket. Риски: вручную поднятый сервер не получает переопределений, которые приложение даёт своему (инструменты codex_app, originator «Codex Desktop»); при падении сервера приложение остаётся без бэкенда до перезапуска без переменной.
  - Проверено 23.09.2026. Сервер: встроенный `…/ChatGPT.app/Contents/Resources/codex` (0.155.0-alpha.9.2) с теми же ключами, что приложение даёт своему (`-c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true`), плюс `--listen ws://127.0.0.1:4599`, переменные `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex` и `CODEX_MCP_NODE_PATH=…/Resources/cua_node/bin/node`. Канала `CODEX_APP_TOOLS_PIPE_PATH` у такого сервера нет. ChatGPT.app, запущенный через `open -a ChatGPT --env CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4599`, подключился к нему. Тестовый клиент на WebSocket (как Пульт) сделал `thread/start` с `gpt-6-astra` и `turn/start`; тред «Волна: эксперимент, Калькулятор» шёл в окне Codex вживую.
  - Запрос доступа (`mcpServer/elicitation/request`, сервер `cua_repl`, `connector_id: computer-use`) пришёл клиенту и одновременно появился в окне Codex. Владелец нажал «разрешить» в Codex: клиент получил `serverRequest/resolved` с `requestId`, но без самого решения, и файла `~/.codex/computer-use/sessions/<threadId>.toml` для такого треда не появилось. Решение видно только по следующему шагу Астры. Обратно: клиент после `thread/resume` сам ответил `accept` с `persist: session`, сервер разослал `resolved`, и Астра продолжила работу. После этого запроса в окне Codex не осталось. Появлялся ли он там на 8 секунд до ответа, владелец не видел.
  - Решение владельца 23.09.2026: доступ к приложению даёт действие владельца в любом клиенте (окно Codex, панель Пульта, карточка Волны на телефоне), засчитывается первый ответ, остальные запросы закрываются по `serverRequest/resolved`. Голосом по-прежнему нельзя. Пульт проксирует запрос: показывает его в панели и отправляет Волне на телефон.
  - Сделано 23.09.2026 (тесты `swift test`, сборка и запуск Пульта; живой прогон с приложением Codex ниже, в разделе 7): `PultCore/CodexHost.swift` поднимает общий сервер на `ws://127.0.0.1:48613` при старте Пульта (бинарник и ключи приложения, лог `~/Library/Logs/VolnaPult-codex.log`) и оставляет его жить после выхода Пульта, чтобы приложение не потеряло бэкенд; при следующем старте переиспользует, если отвечает `/readyz`. Подключено ли приложение, Пульт смотрит раз в 10 с по `lsof` (соединение процесса ChatGPT с портом). Кнопка «Запустить» / «Подключить» (таб «Задания» и настройки, группа «Источники») закрывает приложение как ⌘Q и открывает его с `CODEX_APP_SERVER_WS_URL`. Задания Астры (`ComputerJobs`) идут через `WebSocketCodexTransport` на этот сервер; если он не поднялся, через свой stdio-сервер, как раньше. Запрос доступа становится подтверждением `computer_app`: кнопки в панели и карточка на телефоне отвечают одним путём (`ConfirmationCenter.decide`); ответ в окне Codex приходит как `serverRequest/resolved`, и Пульт снимает подтверждение (`ConfirmationCenter.withdraw`), приложение не попадает ни в разрешённые, ни в отказанные. Треды Астры (папка `VolnaPult/computer`) из таба «Код» убраны.
- Любопытно: `externalAgentConfig/import` и `~/.codex/external_agent_session_imports.json`: Codex умеет импортировать сессии Claude Code. Обратного нет.

### 2.3 Управление компьютером (Computer Use)

Проверено 22.09.2026 на Codex CLI 0.155.1, модель `gpt-6-astra` («Астра», задана в `~/.codex/config.toml`), Computer Use 1.0.1001103. Это путь для класса `computer` из [tools-routing.md](tools-routing.md).

- Устройство: `~/.codex/computer-use/Codex Computer Use.app` (служба `SkyComputerUseService`, держит разрешения macOS на Accessibility и запись экрана) + MCP-клиент `SkyComputerUseClient mcp` с инструментами `list_apps`, `get_app_state` (снимок окна + дерево Accessibility), `click`, `type_text`, `press_key`, `set_value`, `select_text`, `scroll`, `drag`, `perform_secondary_action`. Сама модель зовёт их не напрямую: через MCP `node_repl` из ChatGPT.app и пакет `@oai/sky` (плагины `computer-use` и `unified-computer-use`, подключены в общем `~/.codex/config.toml`, поэтому видны и CLI).
- Служба проверяет вызывающего: клиент, запущенный из нашего процесса, получает `Computer Use server error -10000: Sender process is not authenticated`. Пульт и ядро не могут звать Computer Use сами; только через процесс Codex (оба бинарника, Homebrew и из ChatGPT.app, подписаны OpenAI, Team 2DC432GLL2).
- Codex без интерфейса пускают: `codex exec` и собственный `codex app-server` (как в Пульте) с Астрой вызвали `sky.list_apps()` и получили 14 запущенных приложений. ChatGPT.app при этом не нужен на переднем плане.
- Каждое приложение требует одобрения. Разрешённые хранятся на тред: `~/.codex/computer-use/sessions/<threadId>.toml`, `[apps] allowed = […]`. В `codex exec` одобрять некому: сразу `Computer Use was not approved to use Finder`. Через app-server приходит запрос клиенту `mcpServer/elicitation/request`: `serverName: node_repl`, `message: Allow Computer Use to use "Finder"?`, в `_meta`: `connector_id: computer-use`, `tool_name`, `tool_params_display`, `riskLevel`, `persist: ["session","always"]`. Ответ `{"action":"decline"}` проверен (модель получила отказ и сообщила его). Ответ `accept` не проверен: выдачу разрешения должен сделать владелец.
- Формат ответа на запрос взят из исходников Codex (`codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs`): «разрешить один раз» — `{"action":"accept"}`, «на тред» — `{"action":"accept","_meta":{"persist":"session"}}`, «навсегда» — `persist: "always"`.
- Сделано 22.09.2026 (проверено тестами, живым заданием не проверено): `PultCore/ComputerJobs.swift`. Своё `codex app-server` поднимается на первое задание; `thread/start` с `gpt-6-astra`, папка `~/Library/Application Support/VolnaPult/computer`, `approvalPolicy: on-request`; в ход уходят правила (без паролей, покупок, денег, удаления, отправки сообщений, системных настроек) и задача. Запрос Computer Use на приложение (`ComputerAppRequest`) становится подтверждением `computer_app` в `ConfirmationCenter`; нажатие на телефоне отвечает `persist: session`, отказ и истечение 2 минут — `decline`; `always` Пульт не выдаёт никогда. Всё остальное, что спрашивает Codex в таком треде (команды вне песочницы, чужие формы), отклоняется. Итог — последний `agentMessage` с `phase: final_answer`; задание дольше 15 минут прерывается. Маршруты: `POST /computer` `{ text }`, `GET /computer`, `GET /computer/{id}`, `POST /computer/{id}/cancel`; задание: `state` `starting|working|needs_you|done|failed|cancelled`, `pendingApp`, `allowedApps`, `declinedApps`, `reply`, `error`, с 23.09.2026 ещё `activity` (последние 30 шагов: реплики `commentary`, `reasoning.summary`, `mcpToolCall`, `commandExecution`) и `activityTotal`; из них ядро делает фразу «что сейчас происходит» ([core.md](core.md), 4i). Ядро: инструмент `computer_start` ([core.md](core.md), 4e). Карточка на телефоне для `computer_app` сделана по [design/volna-computer.html](design/volna-computer.html) (решения владельца 22.09.2026: без Face ID, доступ до конца задания); проверена в симуляторе снимком `DesignScreenshots`, на iPhone и живым заданием не проверена.

## 3. Что нашли: Claude Code и Claude Desktop

### 3.1 Живые сессии

- `claude agents --json` (и `--all` с завершёнными): документированный, «стабильный программный интерфейс». На этой машине вернул 5 сессий Claude Desktop с полями `sessionId`, `name`, `status` (busy/idle/waiting), `state`, `cwd`, `kind`, `waitingFor`.
- Реестр под капотом: `~/.claude/sessions/<pid>.json` с `sessionId`, `name`, `status`, `entrypoint: claude-desktop`, `hostSessionId: local_…` (это id сессии в Claude Desktop), `messagingSocketPath`, `bridgeSessionId` (Remote Control). Рядом `<pid>.<hash>.key`: токен инбокса. Формат внутренний, читать только как запасной источник.
- Инбокс каждой сессии: unix-сокет `/tmp/cc-socks/<pid>.sock` (или `/tmp/cc-socks-<uid>/`). Документация прямо говорит: «когда нужно, чтобы скрипт или хук постил в сессию». Первая строка соединения опционально `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}`, дальше сообщение одной строкой; соединение закрывается через 30 с без полной строки. Кадр сообщения проверен 22.09.2026 на 2.1.278 и совпадает с пользовательским сообщением stream-json: `{"type":"user","message":{"role":"user","content":"текст"}}`, необязательное поле `from` подписывает отправителя. Сессия сама печатает этот рецепт в свой `--debug-file` при старте. Сессия в режиме ожидания начинает с сообщения новый ход. Доставка: сессия в обычном режиме принимает, сессия с bypass-режимом держит на одобрение; настройка `crossSessionInbound: accept|hold|refuse`.
- Фоновые сессии: `claude --bg "…"`, супервизор-демон, `claude attach|logs|stop|respawn|rm`, `claude daemon status`. Сейчас демон не запущен (`not running`), но это и не нужно для десктоп-сессий.

### 3.2 Свои сессии

- Claude Desktop сам запускает `claude --output-format stream-json --verbose --input-format stream-json --effort … --model … --permission-…` на каждую сессию (видно в `ps`). Тот же режим доступен нам: потоковый ввод (много ходов в одном процессе, картинки, очередь, `interrupt`), запросы разрешений к хосту (`--permission-prompts host`, в SDK это `canUseTool`), хуки, `--resume <id>`, `--fork-session`, `--session-id`, `--name`, `--bare` для дешёвых утилитарных вызовов.
- Сессии, созданные нами, ложатся в `~/.claude/projects/<slug>/<sessionId>.jsonl` и появляются в `/resume` Claude Desktop и CLI. И наоборот: сессию Claude Desktop, которая сейчас не запущена, можно продолжить у себя через `--resume`. Одновременный resume в двух процессах: не делать.
- Чтение истории: SDK `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`. Формат `.jsonl` объявлен внутренним и меняется между версиями.

### 3.3 События наружу

- Хуки в `~/.claude/settings.json` действуют на все сессии пользователя, включая Claude Desktop. HTTP-хук получает JSON события POST-запросом. Нужные события: `SessionStart`, `SessionEnd`, `Stop`, `Notification`, `PermissionRequest`, `UserPromptSubmit`. Это документированный способ получать «пуш» из чужих сессий без опроса.
- Cross-session messaging между сессиями Claude (`SendMessage`/`ListAgents`) работает по тем же сокетам.

### 3.4 Что недоступно

- Публичного API у Claude Desktop нет. MCP-инструменты `ccd_session_mgmt` (list_sessions, send_message, get_session, list_events, set_session_model…) видны только сессии внутри Claude Desktop. Обходной вариант «прокси-сессия внутри Desktop, которой мы пишем в инбокс» возможен, но хрупок; в план не берём, держим в запасе.
- Облачные сессии: только через CLI (`claude --cloud "описание"`, `claude -p --cloud <id> "сообщение"`, `claude --teleport`). REST-API нет. Remote Control (телефон ↔ локальная сессия) идёт через серверы Anthropic и сторонним клиентам закрыт; нашему Mac-приложению он не нужен, оно локальное.
- Deep-link `claude://claude.ai/epitaxy/<local_id>` открывает сессию в Claude Desktop; `local_id` берётся из `hostSessionId` в `~/.claude/sessions/<pid>.json`. Не документирована. Использовать только как кнопку «Открыть в Claude», с graceful fallback.
- У ChatGPT.app есть URL-схема `codex://`; в бандле найдены маршруты `codex://threads/<threadId>`, `codex://threads/new?q=…`, `codex://review?pr=…`, `codex://launch`, `codex://settings/connections`. Не документировано; кнопка «Открыть в Codex» с fallback.

### 3.5 Телефон, Remote Control и вопросы сессий (проверено 23.09.2026, Claude Code 2.1.278)

- Claude Desktop включает Remote Control всем новым сессиям (`ccRemoteControlDefaultEnabled: true` в `claude_desktop_config.json`); у таких сессий в `~/.claude/sessions/<pid>.json` есть `bridgeSessionId`. С телефона (вкладка Code) их видно, можно писать и отвечать на вопросы; нужен запущенный Desktop и неспящий Mac.
- С 23.09.2026 CallAssistant — git-репозиторий (ветка `main`), чтобы работали worktree.
- Новые сессии с телефона: `claude remote-control --name Волна --spawn worktree --permission-mode auto` в папке проекта. Требует один раз принятого доверия папке; без терминала на stdin выходит сразу (запускать с открытым stdin, например `tail -f /dev/null | script -q /dev/null claude remote-control …`). Сессия, созданная с телефона, идёт в `.claude/worktrees/server-cse_…`, в реестре `entrypoint: sdk-cli`, есть `messagingSocketPath` и `bridgeSessionId`, видна в `claude agents --json`. Живьём с iPhone проверено. Сессия, которую сервер создаёт при старте, работает в основной папке; отключается `--no-create-session-in-dir`.
- Запуск без интерфейса для Волны: `claude --bg --remote-control <имя> --permission-mode auto -n <имя> "<задача>"` сразу печатает id, сессия получает `bridgeSessionId` (видна на телефоне), работает в auto без вопросов и в git-папке сама уходит в worktree. Замена пути с deep-link и Return через Accessibility (раздел 5, этап 4).
- Открытый вопрос `AskUserQuestion` снаружи ответить нельзя: сообщение в инбокс-сокет встаёт в очередь (`queue-operation: enqueue`) и доставляется после ответа. Статус в `claude agents --json`: `waiting`, `waitingFor: "input needed"`; текст вопроса и варианты в последнем `tool_use` транскрипта (формат внутренний).
- Ответить можно до показа вопроса: хук `PreToolUse` с `matcher: AskUserQuestion` получает `session_id`, `cwd`, `tool_use_id` и `tool_input.questions`, возвращает `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{…, "answers":{"<текст вопроса>":"<label варианта>"}}}}`; сессия получает «Your questions have been answered» и продолжает. Хук без вывода (exit 0) оставляет обычный вопрос на телефоне и в Desktop.
- Сделано 23.09.2026: `PultCore/SessionQuestions.swift` (`QuestionDesk`) держит вопрос, только пока ядро опрашивает `GET /questions?listen=1` (окно 8 с), до 240 с; хук `/pult/ask` ставится вместе с остальными хуками Пульта (`ClaudeHooksInstaller`, таймаут 300 с; старая установка дополняется при старте), включить из терминала: `Pult/.build/debug/pult-probe claude hooks on`. Проверено без звонка: удержанный вопрос получил «Груша» через `POST /questions/{id}` и сессия записала её; после остановки опроса вопрос вернулся в сессию через 3 с. Живым звонком не проверено. Ядро: [core.md](core.md), 4e.
- LaunchAgent сервера Remote Control: `scripts/remote-control-agent.sh install [папка] [имя] | uninstall | status` (метка `dev.prototype.wave.remote-control`, лог `~/Library/Logs/WaveRemoteControl.log`, `--no-create-session-in-dir`). Установлен 23.09.2026 для CallAssistant под именем «Волна». Путь к `claude` в plist абсолютный (`~/.local/bin/claude`, симлинк, переживает обновления): у launchd другой PATH. Если прежний сервер той же папки убит, новый несколько минут отвечает «This folder is already served by a terminal `claude remote-control` on this device» (регистрация живёт на стороне Anthropic, локальных следов нет); launchd повторяет раз в 30 с, и сервер поднимается сам (23.09.2026 — около 5 минут).

## 4. Архитектура приложения

Решение владельца 22.09.2026: Пульт живёт в фоне и в строке меню, без окна чатов. Интерфейс только необходимый: панель из трея (кто работает, кто ждёт, открыть в родном клиенте) и маленькое окно настроек. Писать в сессию из панели не нужно (решение владельца 22.09.2026, правки в [design/volna-pult-refresh.html](design/volna-pult-refresh.html)); сообщение в сессию остаётся только у ядра Волны. Разговоры ведутся в родных клиентах; экран чата из первого макета отложен.

Нативное macOS-приложение (SwiftUI `MenuBarExtra`, macOS 15+), без Electron и без Node-прослойки: агенты и так работают на этом Mac, оба протокола — строки JSON, Swift справляется. Дизайн из той же системы «Бакелит и лампа» ([design/volna-design-system.html](design/volna-design-system.html)); панель и настройки в [design/volna-pult.html](design/volna-pult.html).

```
archive/pult/ (Swift-пакет)
├─ PultCore
│   ├─ JSONValue, LineProcess, JSONRPC      транспорт: строки JSON к дочерним процессам
│   ├─ CodexClient                          app-server: thread/list, thread/start, turn/start, одобрения, события
│   ├─ ClaudeSessions                       claude agents --json + реестр ~/.claude/sessions (сокет, deep-link)
│   ├─ ClaudeStreamSession                  своя сессия claude -p stream-json с хостом разрешений (для этапа 4)
│   ├─ ClaudeInbox, ClaudeHookReceiver      сообщение в живую сессию; приём HTTP-хуков
│   ├─ ClaudeHooksInstaller                 хуки Пульта в ~/.claude/settings.json (с копией .pult-backup)
│   └─ AgentHub, HubSession, HubChange      единый список сессий обоих агентов и переходы → уведомления
├─ Pult (приложение)                        MenuBarExtra-панель, окно настроек, уведомления macOS
├─ pult-probe                               проверки протоколов из терминала
└─ PultCoreTests
```

Сборка бандла: `archive/pult/scripts/build-pult-app.sh --run` собирает `build/Pult.app` (LSUIElement, без иконки в Dock) и запускает его. Подписывается первым сертификатом «Apple Development» из связки (или `PULT_SIGN_IDENTITY`): с ad-hoc подписью macOS сбрасывал «Универсальный доступ» после каждой пересборки, с сертификатом разрешение сохраняется. Иконки: `scripts/make-pult-icons.swift` делает `Pult/Resources/AppIcon.icns` из иконки iOS-приложения (скруглённый квадрат 824/1024 по правилам macOS) и шаблонную миниатюру знака-волны `MenuBarIcon.png`/`@2x` для строки меню; перегенерировать, если поменяется знак. Журнал приложения: `~/Library/Logs/VolnaPult.log`.

Что делает фон: опрос `claude agents --json` раз в 8 с, приём хуков на 127.0.0.1:48611 (если включены в настройках), свой `codex app-server` с `thread/list` раз в 30 с. Переходы состояний (появилось «ждёт тебя», ход закончен, помехи) уходят в уведомления macOS; клик по уведомлению открывает сессию в родном клиенте. Из панели можно написать в живую сессию Claude (инбокс-сокет) по явному действию; после отправки сессия открывается в своём приложении по той же ссылке, что у кнопки «Открыть» (правило для любого агента).

Инварианты, которые переносим из [architecture.md](architecture.md):
- Состояние сессий меняется только через события и редьюсер; побочные эффекты (процессы, сокеты, HTTP) в сервисах.
- Ключи и токены (capability-token демона Codex, токен ядра Волны) только в Keychain; в логи не попадают.
- Одобрения команд и правок всегда показываем человеку; режимы «bypass» из приложения не включаем.
- Транскрипты и реестры чужих приложений читаем только на чтение; пишем только через их протоколы.

## 5. Этапы

### Этап 0. Спайк протоколов (1–2 дня, без UI)

Цель: подтвердить каждый «кирпич» кодом до того, как рисовать экраны.

1. Codex: Swift JSON-RPC-клиент поверх `Process` + pipes → `initialize`, `thread/list` (limit 5, все `sourceKinds`), `thread/start`, `turn/start` с текстом, печать `item/agentMessage/delta`, ответ на `item/commandExecution/requestApproval`, `turn/interrupt`. Типы: `codex app-server generate-json-schema` → quicktype в Swift для нужного подмножества; схему кладём в репозиторий с версией CLI.
2. Claude, список: парсер `claude agents --json --all`; сопоставление с `~/.claude/sessions/<pid>.json` для `hostSessionId` и `messagingSocketPath`.
3. Claude, своя сессия: подпроцесс `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts host --name "Пульт: тест"`, два хода, обработка запроса разрешения, `--resume`.
4. Claude, инбокс: поднять тестовую `claude -p`-сессию с `--settings '{"crossSessionInbound":"accept"}'`, подобрать форму строки сообщения на сокете (auth-строка + сообщение), убедиться, что сообщение стало новым ходом. Записать найденный формат сюда с пометкой версии.
5. Claude, хуки: локальный HTTP-приёмник на 127.0.0.1, хук `Stop` и `Notification` в пользовательских настройках, проверить приход событий из сессии Claude Desktop.
6. Deep-links: `claude://claude.ai/epitaxy/<local_id>` и `codex://…` (подобрать параметры или отказаться).

Выход: таблица «работает / не работает / версия» в этом документе, раздел 7.

### Этап 1. Фоновый пульт (сделан 22.09.2026)

Панель в строке меню: единый список сессий обоих агентов по группам «ждут тебя / в работе / в ожидании / вне эфира», источник, проект, время; клик по строке открывает сессию в Claude/Codex. Уведомления macOS о переходах. Окно настроек: уведомления, хуки Claude, треды Codex, журнал. Проверено на этой машине: приложение запускается из трея, приёмник хуков и app-server поднимаются, `claude -p` с хуками присылает события (см. раздел 7).

### Этап 2. Обкатка в фоне

Пожить с Пультом неделю: проверить, не мешают ли хуки сессиям Claude Desktop (таймаут 3 с при выключенном Пульте), точность «работает/ждёт» для тредов Codex, шум уведомлений. Автозапуск при входе (LaunchAgent или Login Item) после обкатки.

### Этап 3. Вмешательство в чужие сессии Codex

Из панели в сессию не пишем. Для сообщений от Волны в Codex: `codex queue --thread <id> --message …` или `thread/resume` + `turn/start`, только по явному действию и после эксперимента с одновременным resume (раздел 2.2). Чат-интерфейс не планируется: разговоры остаются в родных клиентах.

### Этап 4. Связка с Волной (первый прототип сделан 22.09.2026)

Сделано проще, чем планировалось: Пульт не становится клиентом ядра, а поднимает loopback HTTP-API (`PultCore/BridgeAPI.swift`: `BridgeAPIServer`, чистый `BridgeRouter`, токен `BridgeToken` в Связке ключей), а ядро зовёт его из инструментов `agents_list`, `agents_send`, `agents_open` (`core/src/assistant/tools/pult.ts`, протокол в [core.md](core.md), 4e). Оба процесса живут на одном Mac, поэтому WebRTC и sideband для Пульта не нужны. Настройка: Пульт → Настройки → «Волна» (тумблер, порт 48612, «Скопировать» токен) → `core/.env`: `PULT_URL`, `PULT_TOKEN`. Сценарий сейчас: «Волна, кто из агентов ждёт?» → `agents_list`; «передай в сессию X: …» → бэкенд диктует текст, `agents_send` кладёт его в инбокс Claude-сессии; «открой её» → `agents_open`.

Сделано следом 22.09.2026: `agents_start` открывает новый чат Claude Code в Claude Desktop (`POST /sessions`, `Hub.startDesktopChat` через `NewSessionLink.claude`) в папке, найденной по продиктованному имени (`ProjectMatch`); `lastReply` в `GET /sessions` из хука `Stop`. Claude Desktop не отправляет промпт, пришедший ссылкой: в его коде такой промпт помечается небезопасным («Use caution before running this prompt»), и автоотправка для него выключена; поэтому по решению владельца 22.09.2026 Return нажимает Пульт (`ClaudeDesktopComposer`): открывает ссылку, ждёт до 8 с, пока Claude окажется впереди, а сфокусированное поле (Accessibility, `AXManualAccessibility` для Electron) будет содержать ровно продиктованный текст, шлёт Return процессу Claude (`CGEvent.postToPid`), проверяет, что поле опустело, и до 10 с ищет новую запись `~/.claude/sessions` с этой папкой. Любой сбой оставляет чат с вписанным текстом. Нужен «Универсальный доступ» для Пульта (Настройки → «Новые чаты Claude», там же тумблер); подпись ad-hoc, после пересборки разрешение выдаётся заново. Путь без Accessibility: своя сессия (`OwnRun`) и `/resume` в Desktop.

Окно «Trust this workspace?» для недоверенной папки Пульт сам не нажимает: `ClaudeDesktopComposer` находит его через Accessibility (заголовок, путь, кнопки «Trust workspace» и «Cancel»), `ConfirmationCenter` заводит запрос на 2 минуты, решение приходит только нажатием на телефоне (см. [design/volna-confirm.html](design/volna-confirm.html), [architecture.md](architecture.md), поток «Подтверждения с телефона»); истёкший запрос закрывает окно кнопкой Cancel. Первый живой прогон 22.09.2026: запрос и карточка сработали, «Trust workspace» нажался, но промпт не отправился (`typed_only`): Пульт фоновый, после нажатия на телефоне macOS игнорирует `NSRunningApplication.activate()`. Теперь Claude выводится вперёд атрибутом Accessibility `AXFrontmost`, а поле с промптом ищется по всему окну и получает фокус; при неудаче в журнал пишется, на чём застряло. Сделано 22.09.2026, проверено тестами и снимком в симуляторе, на живом Desktop и iPhone не проверено.

Дальше в этом этапе: (0) живая проверка заданий Астры на Mac и iPhone (раздел 2.3), (1) сообщения в треды Codex (`codex queue` или `thread/resume` после эксперимента 2.2), (2) разрешения агентам (PermissionRequest) тем же путём подтверждений с телефона, не голосом. Проверено 22.09.2026 только тестами (`swift test`, `npm test`); живой голосовой сценарий не проверен.

### Этап 5. Дальше

- Общий демон Codex (`codex app-server daemon start`, при желании `remote-control`), чтобы Пульт и ChatGPT.app держали одни и те же загруженные треды. Сначала проверить, подключается ли ChatGPT.app к общему демону.
- `thread/realtime/*`: голосовой вход в Codex-тред напрямую по WebRTC; кандидат на «Волна звонит Codex».
- Облачные сессии Claude через CLI-обёртки.

## 6. Риски

- Недокументированные места: форма строки инбокса, `~/.claude/sessions/*.json`, deep-links, поведение двух процессов на одном треде Codex. Каждое обёрнуто в свой адаптер с версионной проверкой и тестом-фикстурой, чтобы падало громко и локально.
- Версии: app-server помечен `[experimental]`, Claude Code обновляется несколько раз в неделю. При старте приложения читаем `claude --version` и `codex --version`, сверяем с поддерживаемым диапазоном.
- Стоимость: сообщение в чужую сессию запускает ход и тратит токены владельца. Любая отправка в чужую сессию только по явному действию пользователя.
- Безопасность: приложение становится хостом разрешений для своих сессий; логика одобрений и запретов та же, что в родных клиентах, без «принять всё».

## 7. Журнал проверок

| Дата | Кирпич | Версия | Результат |
|---|---|---|---|
| 22.09.2026 | `codex app-server generate-json-schema` | Codex 0.155.1 | Схема сгенерирована, 102 клиентских метода |
| 22.09.2026 | `codex app-server daemon version` | Codex 0.155.1 | Демон не запущен; ChatGPT.app держит свой app-server |
| 22.09.2026 | `claude agents --json` | Claude Code 2.1.278 | 5 сессий Claude Desktop с именами и статусами |
| 22.09.2026 | `~/.claude/sessions/<pid>.json`, `/tmp/cc-socks/*.sock` | 2.1.275 (десктоп) | Есть `hostSessionId`, `messagingSocketPath`, `bridgeSessionId` |
| 22.09.2026 | `claude daemon status` | 2.1.278 | Супервизор не запущен, для десктоп-сессий не нужен |
| 22.09.2026 | `pult-probe codex list --all` | Codex 0.155.1 | Swift-клиент видит треды ChatGPT.app и CLI; `updatedAt` в секундах |
| 22.09.2026 | `pult-probe codex turn` | Codex 0.155.1 | initialize → thread/start → turn/start, дельты ответа и item/* приходят, turn/completed |
| 22.09.2026 | `pult-probe claude agents` | 2.1.278 | 7 сессий Claude Desktop, у каждой сокет и deep-link |
| 22.09.2026 | `pult-probe claude turn` | 2.1.278 | Два хода в одном процессе stream-json, `--resume` не требуется; `echo` прошёл без запроса разрешения (read-only команда) |
| 22.09.2026 | `pult-probe claude turn` (touch) | 2.1.278 | `control_request can_use_tool` пришёл в наш процесс, `deny` вернул сессии ошибку инструмента, модель ответила «отказ» |
| 22.09.2026 | `pult-probe claude inbox-test` | 2.1.278 | Кадр `{"type":"user","message":{…}}` доставлен, сессия ответила новым ходом; `from` принимается |
| 22.09.2026 | `pult-probe claude hooks` | 2.1.278 | HTTP-хуки через `--settings`: UserPromptSubmit, Stop, SessionEnd пришли на 127.0.0.1 |
| 22.09.2026 | `scripts/build-pult-app.sh --run` | Pult 0.1.0 | Приложение запустилось из трея: хуки слушают 48611, app-server Codex поднят, уведомления разрешены |
| 22.09.2026 | `claude -p … --settings '{hooks → 127.0.0.1:48611/pult/hook}'` | 2.1.278 | Запущенный Пульт получил UserPromptSubmit, Stop, SessionEnd и показал уведомление «Готово»; SessionStart через `--settings` не приходит (хук читается позже старта). Панель визуально не проверена: `screencapture` без разрешения на запись экрана |
| 22.09.2026 | панель Пульта, скриншот владельца | Pult 0.1.0 | Список схлопывался в нулевую высоту (ScrollView в MenuBarExtra); высота теперь считается от строк. Модель и effort сессии Claude берутся из аргументов её процесса (`ps -o args`), у Codex из `thread.model`/`reasoningEffort`; у строки фирменный знак агента из Simple Icons (`Pult/Resources/claude-logo.svg`, `openai-logo.svg`), растрируется скриптом иконок |
| 22.09.2026 | кадры инбокса с auth-токеном сессии, `origin: human`, без `from` | 2.1.278 | Любой кадр из сокета записывается в транскрипт как `origin.kind = peer`, `promptSource = system` и оборачивается текстом «Another Claude session sent a message». Это инвариант Claude Code: сообщение из сокета никогда не считается вводом владельца. Deep-link `claude://code/continue?session=…` только открывает сессию, параметр `q`/`prompt` принимает лишь `claude://code/new` (новая сессия с заполненным полем) |
| 22.09.2026 | `open codex://threads/<id>`, `open claude://claude.ai/epitaxy/<id>` | ChatGPT.app, Claude.app | `open` принял обе ссылки (код 0); визуально не проверено. Маршруты `codex://threads/<id>`, `codex://review`, `codex://launch` найдены в бандле ChatGPT.app |
| 22.09.2026 | `SkyComputerUseClient mcp` из своего процесса | Computer Use 1.0.1001103 | `tools/list` отвечает (10 инструментов), `tools/call list_apps` → `Sender process is not authenticated` |
| 22.09.2026 | `codex exec` + `sky.list_apps()` | Codex 0.155.1, gpt-6-astra | Работает без интерфейса, 14 запущенных приложений; ~66 тыс. входных токенов на ход (из них 55 тыс. из кэша) |
| 22.09.2026 | `codex exec` / `codex app-server` + `sky.get_app_state(Finder)` | Codex 0.155.1 | exec: сразу «not approved»; app-server: `mcpServer/elicitation/request` «Allow Computer Use to use "Finder"?», `decline` вернул модели отказ; `accept` не проверен |

## 8. Источники

- Codex app-server: https://developers.openai.com/codex/app-server (перенаправляет на learn.chatgpt.com/docs/app-server.md), README демона https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md
- Claude Code: https://code.claude.com/docs/en/agent-view, https://code.claude.com/docs/en/cross-session-messaging, https://code.claude.com/docs/en/headless, https://code.claude.com/docs/en/agent-sdk/sessions, https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode, https://code.claude.com/docs/en/remote-control, https://code.claude.com/docs/en/desktop, https://code.claude.com/docs/en/hooks
