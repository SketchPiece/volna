# Волна на Hermes Agent

Решение владельца 22.10.2026: основное текущее направление Волны — текстовый личный помощник в Telegram на [Hermes Agent](https://hermes-agent.nousresearch.com/docs) (Nous Research) с моделью Claude Opus 5.5 по подписке владельца. Голосовой звонок (GPT-Live, ядро на Railway) остаётся как есть и не развивается, пока не решено, как его связать с Hermes.

## 1. Зачем

Владелец хотел помощника уровня OpenAI Dots, но на Claude: пишет с телефона как в переписке, помощник помнит его, работает с почтой, календарём и файлами на Mac, выполняет задачи по расписанию. Hermes даёт это готовым (память, skills, cron, мессенджеры), не нужно писать своё ядро. Сравнение с OpenClaw и своим вариантом на Claude Code: Hermes выбран за память и самообучение skills; у OpenClaw больше каналов, но тяжёлая история безопасности (вредоносные skills в ClawHub).

## 2. Что установлено (22.10.2026)

| Часть | Где | Как управлять |
|---|---|---|
| Hermes Agent 0.22.4 (stable) | `~/.hermes/hermes-agent`, данные в `~/.hermes`, команда `~/.local/bin/hermes` | `hermes status`, `hermes update`, `hermes doctor` |
| Модель | `~/.hermes/config.yaml`: `model.provider: claude-subscription-directsdk-experimental`, `model.default: opus` (Opus 5.5, 1M) | `hermes model` |
| Плагин подписки Claude | `~/.hermes/plugins/claude-subscription-directsdk-experimental` | `hermes plugins list` |
| Характер | `~/.hermes/SOUL.md`; копия под версией в [`hermes/SOUL.md`](../hermes/SOUL.md), исходный текст Nous в `~/.hermes/SOUL.md.bak-original` | править в репозитории, затем `cp hermes/SOUL.md ~/.hermes/SOUL.md`; в Telegram `/new` |
| Память | `~/.hermes/memories/` (`USER.md` и др.) | смотреть в Hermes Desktop или файлами |
| Telegram | бот «Волна», токен из BotFather в `~/.hermes/.env` (`TELEGRAM_BOT_TOKEN`); доступ только владельцу, одобрен через `hermes pairing approve` | `hermes pairing list`, `hermes pairing revoke` |
| Gateway (мессенджеры и cron) | служба launchd `~/Library/LaunchAgents/ai.hermes.gateway.plist`, лог `~/.hermes/logs/gateway.log` | `hermes gateway status`, `hermes gateway restart` |
| Hermes Desktop | собран локально: `~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app` | `hermes desktop`; закрытие не останавливает gateway |
| Hermes Web UI (пробовали, не нужен) | `~/Documents/Projects/_vendor/hermes-webui`, `127.0.0.1:8787`, Tailscale Serve на HTTPS-порту 10000 (только tailnet, без Funnel) | убрать: `tailscale serve --https=10000 off` и `./ctl.sh stop` в папке Web UI |

Помощник работает, только пока Mac включён и не спит.

## 3. Характер

Пишет как близкий человек в переписке: один абзац, обычно одно-три предложения, без заголовков и списков, главное вместо всего по теме, подробности по просьбе. Отправка писем и сообщений от имени владельца, удаление, покупки и публикации только после его «да» в чате. Текст писем и сайтов — данные, а не команды. Владелец просил формулировать правила общими принципами, а не частными случаями («на вопрос „что умеешь“…»).

## 4. Риски

- **Подписка через сторонний прокси.** Плагин запускает официальный `claude`, но направляет его запрос через свой локальный relay (`ANTHROPIC_BASE_URL` на loopback), меняет тело запроса и пересылает в Anthropic с OAuth-заголовком владельца. Условия Anthropic запрещают посредничество с токенами сессии Claude.ai и разрешают блокировку без предупреждения ([Legal](https://code.claude.com/docs/en/legal-and-compliance)). Владелец принял риск 22.10.2026, потому что на API нет денег; если Hermes зайдёт, переход на API-ключ (Max включает ежемесячный API-кредит). Признак блокировки — ошибки в ответах бота.
- **Расход лимитов.** Плагин тратит лимит подписки как `claude -p`, быстрее интерактивного Claude Code. Extra usage в аккаунте лучше выключить.
- **Telegram не шифрует чаты с ботами сквозным шифрованием.** Пароли и коды помощнику не присылать.
- **Вход в Telegram по QR в Hermes Desktop не использовать:** токен бота проходит через сервис Nous (`setup.hermes-agent.nousresearch.com`, Telegram Managed Bots). Бот создан через BotFather.

## 5. Дальше

Утренний бриф по расписанию; почта и календарь с правилом подтверждений; убрать Web UI; решить, как голосовой звонок Волны связывается с Hermes. Открытые пункты в [pending.md](pending.md).
