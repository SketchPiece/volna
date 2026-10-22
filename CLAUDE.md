# CLAUDE.md

Не раздувай этот файл. Он содержит только ссылки на документы, где факты уже зафиксированы, и по одной строке, зачем каждая ссылка нужна. Новое знание о проекте сначала пишется в `docs/` (или в `AGENTS.md`, если это правило для агентов), затем здесь появляется ссылка. Описания, инструкции и история изменений сюда не переносятся.

@AGENTS.md

## Ссылки

- [AGENTS.md](AGENTS.md): правила работы, команды, что читать первым.
- [docs/hermes.md](docs/hermes.md): текущее основное направление — Волна на Hermes Agent в Telegram (установка, характер, риски).
- [docs/vision.md](docs/vision.md): общая цель и порядок шагов к ней.
- [docs/architecture.md](docs/architecture.md): архитектура, инварианты, план развития. Обновлять при изменении границ модулей.
- [docs/core.md](docs/core.md): ядро и инструменты ассистента.
- `~/Documents/Projects/helm-cloud` (README и `docs/`): «Узел», Helm MCP, пуши и диктовка «Штурвала»; ядро ходит к «Узлу» через неё.
- [docs/ci-cd.md](docs/ci-cd.md): ветки и PR, самопроверка перед PR, CI и автодеплой.
- [docs/railway.md](docs/railway.md): ядро, helm-cloud и почтовый сервис на Railway (проект, тома, переменные, порядок деплоя и переноса данных).
- [docs/task-sync.md](docs/task-sync.md): синхронизация заданий Волны и тредов T3 Code.
- [docs/skills.md](docs/skills.md): техкарты как скиллы (формат, источники, установка).
- [docs/design/volna-design-system.html](docs/design/volna-design-system.html): дизайн-система, единственный источник визуальных решений.
- [docs/test-protocol.md](docs/test-protocol.md): протокол тестирования всех функций.
- [README.md](README.md): запуск и статус.
