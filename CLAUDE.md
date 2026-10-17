# CLAUDE.md

Не раздувай этот файл. Он содержит только ссылки на документы, где факты уже зафиксированы, и по одной строке, зачем каждая ссылка нужна. Новое знание о проекте сначала пишется в `docs/` (или в `AGENTS.md`, если это правило для агентов), затем здесь появляется ссылка. Описания, инструкции и история изменений сюда не переносятся.

@AGENTS.md

## Ссылки

- [AGENTS.md](AGENTS.md): правила работы, команды, что читать первым.
- [docs/vision.md](docs/vision.md): общая цель и порядок шагов к ней.
- [docs/architecture.md](docs/architecture.md): архитектура, инварианты, план развития. Обновлять при изменении границ модулей.
- [docs/core.md](docs/core.md): ядро и инструменты ассистента.
- [docs/relay.md](docs/relay.md): «Узел», связь ядра в облаке с T3 Code на Mac, и план «Штурвала».
- [docs/helm-mcp.md](docs/helm-mcp.md): Helm MCP, «Штурвал» из Claude владельца через ядро.
- [docs/ci-cd.md](docs/ci-cd.md): ветки и PR, самопроверка перед PR, CI и автодеплой.
- [docs/railway.md](docs/railway.md): ядро и почтовый сервис на Railway (проект, тома, переменные, порядок деплоя и переноса данных).
- [docs/task-sync.md](docs/task-sync.md): синхронизация заданий Волны и тредов T3 Code.
- [docs/skills.md](docs/skills.md): техкарты как скиллы (формат, источники, установка).
- [docs/design/volna-design-system.html](docs/design/volna-design-system.html): дизайн-система, единственный источник визуальных решений.
- [docs/test-protocol.md](docs/test-protocol.md): протокол тестирования всех функций.
- [README.md](README.md): запуск и статус.
