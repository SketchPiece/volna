# Ядро, helm-cloud и почта на Railway

Задеплоено 27.09.2026: ядро отвечает на `/health`, память перенесена (32 записи), плагин почты подключён по внутренней сети (5 инструментов `mail_*`; с 03.10.2026 шестой, `mail_mark_read`, выкачен в облако), ящик в почте один. На iPhone с этим адресом ещё не проверено. Проект Railway `Helm` (до 21.10.2026 `volna`; id `<railway-project-id>`, окружение `production`), три сервиса:

| Сервис | Код | Том | Адрес |
|---|---|---|---|
| `volna` (до 21.10.2026 `core`) | `core/` этого репозитория (`SketchPiece/volna`, ветка `main`, корень `/core`), `core/railway.json` (Railpack, Node 24 из `core/.node-version`, `node src/main.ts`, проверка `/health`) | `core-data` → `/data` | публичный `https://your-core.example.com` |
| `helm` | helm-cloud (`~/Documents/Projects/helm-cloud`, его README): «Узел», Helm MCP, пуши и диктовка «Штурвала» | `helm-data` → `/data` | внутренний `http://helm.railway.internal:8788`, публичный домен сервиса `helm` |
| `mail-triage` | `~/Documents/Sandbox/mail-triage` (`SketchPiece/mail-triage`, ветка `main`), его `railway.json` (`node src/server.ts`, без `--env-file`) | `mail-data` → `/data` | только внутренняя сеть: `http://mail-triage.railway.internal:8790/mcp` |

## 1. Что уже задано

Регион: сервисы и тома в Амстердаме (`europe-west4-drams3a`), с 27.09.2026; до этого по умолчанию стоял Сингапур. Регион сервиса задаётся `serviceInstanceUpdate` с `multiRegionConfig` (или Settings → Scale → Regions), том переезжает при следующем деплое, сервис в это время недоступен (у нас около минуты). Перед переездом снять копию тома: `railway ssh --service <имя> -- "tar czf - -C /data ." > копия.tgz` (копии 27.09.2026 в `core/data/backups/`, вне Git). Позже возможен переезд в `us-east4` (Вирджиния), ближе к Канаде и к OpenAI.

Ядро: `HOST=::` (внутренняя сеть Railway работает по IPv6), `PORT=8787`, `ASSISTANT_TIMEZONE=Europe/Berlin` (в контейнере UTC), `MEMORY_DIR=/data`, `METRICS_DIR=/data/metrics`, `APNS_KEY_PATH=/data/apns.p8`, `MAIL_TRIAGE_URL` и `MAIL_TRIAGE_TOKEN` ссылками на сервис почты, `HELM_CLOUD_URL=http://helm.railway.internal:8788`.

Почта: `HOST=::`, `PORT=8790`, `DATA_DIR=/data`, `GOOGLE_CREDENTIALS=/data/credentials.json`, `TZ=Europe/Berlin`, `SYNC_INTERVAL_MIN=10`.

## 2. Секреты (задаёт владелец)

Railway → `Helm` → сервис → Variables → Raw Editor. Значения берутся из локальных файлов и на экран агентам не попадают.

- `volna`: `OPENAI_API_KEY`, `OPEN_ROUTER_API_KEY` (из `core/.env`), `BRIDGE_TOKEN` — тот же, что в `core/.env.device`: он уже в Keychain телефона, после переезда меняется только адрес. По желанию `APNS_KEY_ID`, `APNS_TEAM_ID` (перезвоны и уведомления), `OPENAI_ADMIN_KEY` (сверка расходов), `TYPESAFE_API_KEY`.
- `mail-triage`: `OPENROUTER_API_KEY` (из его `.env`), `MAIL_TRIAGE_TOKEN` — новый, `openssl rand -hex 32`. Ядро получает его ссылкой.

`HELM_TOKEN` в облаке не задаётся: «Работа» идёт в «Штурвале» на Mac через «Узел», а к «Узлу» ядро ходит через сервис `helm` (`/internal/relay`). В `volna` заданы `HELM_INTERNAL_TOKEN` (тот же, что `INTERNAL_TOKEN` у `helm`), `HELM_PROJECT_DIR=/Users/sketchpiece/Documents/Volna Work` и `HELM_NEW_PROJECTS_DIR=/Users/sketchpiece/Documents` (полные пути Mac: `~` в контейнере не тот; прежние имена `T3_*`, если они ещё заданы в Railway, ядро читает как запасные). Пока «Узел» не на связи, запросы к «Штурвалу» падают `helm_offline`, как у закрытого «Штурвала».

`RELAY_TOKEN`, `HELM_SERVER_TOKEN`, `HELM_DEVICE_TOKEN`, `MCP_*` и ключ диктовки задаются у сервиса `helm`, не у `volna`; список в README helm-cloud.

## 3. Деплой

С 03.10.2026 оба сервиса подключены к GitHub (приложение Railway с доступом к двум репозиториям), «Wait for CI» включён (`deploymentTriggerUpdate … checkSuites: true`). Обычный путь — мерж PR в `main`: Railway выкатывает сам после зелёного CI ([ci-cd.md](ci-cd.md)). Ручной `railway up` ниже — для первого запуска и аварий; у сервиса, подключённого к GitHub, корень `/core`, поэтому вручную выкатывать из корня репозитория без `--path-as-root`.

Команда старта задана в настройках сервисов (`node src/main.ts`, `node src/server.ts`): `startCommand` из `railway.json` при `railway up --path-as-root` не применился, почта стартовала через `npm start` с `--env-file=.env` и падала. `service redeploy` повторяет старый снимок настроек, после смены команды нужен новый `railway up`. Railway предупреждает, что `railway.json` (config as code) работает до 01.12.2026, дальше `.railway/railway.ts`.

После секретов, из корня репозитория:

```sh
railway up ~/Documents/Sandbox/mail-triage --path-as-root --service mail-triage --ci
railway up core --path-as-root --service volna --ci
curl https://your-core.example.com/health
```

## 4. Данные (после первого деплоя: файлы тома доступны только при работающем сервисе)

`railway volume files` ходит по SSH: нужен ключ в аккаунте Railway (`railway ssh keys add`, 27.09.2026 добавлен `~/.ssh/id_ed25519.pub` как `my-mac`). Базу SQLite нельзя класть поверх работающей: запущенный сервис уже создал пустую базу с `-wal` и `-shm`, и старый журнал накатился бы на новую. Поэтому база заливается под именем `mail-triage.db.new`, а внутри контейнера подменяется: `railway ssh --service mail-triage -- sh -c 'cd /data && rm -f mail-triage.db-wal mail-triage.db-shm && mv mail-triage.db.new mail-triage.db'`, затем перезапуск. `railway service restart` может зависнуть, надёжнее `railway api 'mutation { deploymentRestart(id: "…") }'`.

Переносится память без замеров и истории консоли (решение владельца 27.09.2026): `memory.json`, `persona.json`, `skills/`, `tasks.json`, `callbacks.json`, `greeting.json`, `push.json`, `transcripts/`, `apns.p8`. `helm.json` и `helm-mcp-passkey.json` с 21.10.2026 лежат на томе `helm-data` сервиса `helm`. Плагин почты ставится в копию и включается на Mac: MCP-плагины включает только владелец ([skills.md, 7](skills.md#7-плагины)).

```sh
rsync -a --exclude metrics --exclude console core/data/ /tmp/volna-data/
(cd core && MEMORY_DIR=/tmp/volna-data npm run plugins -- add ~/Documents/Sandbox/mail-triage/volna-plugin/mail \
  && MEMORY_DIR=/tmp/volna-data npm run plugins -- enable mail)
for f in /tmp/volna-data/*; do railway volume files --volume core-data upload "$f" "/${f:t}" --overwrite; done

mkdir -p /tmp/mail-data
sqlite3 ~/Documents/Sandbox/mail-triage/data/mail-triage.db ".backup /tmp/mail-data/mail-triage.db"
cp ~/Documents/Sandbox/mail-triage/credentials.json /tmp/mail-data/
for f in /tmp/mail-data/*; do railway volume files --volume mail-data upload "$f" "/${f:t}" --overwrite; done

railway service restart --service mail-triage && railway service restart --service volna
rm -rf /tmp/volna-data /tmp/mail-data
```

После переноса остановить локальные копии на Mac, чтобы почта не синхронизировалась дважды, а память не расходилась.

## 5. Телефон

Настройки → Режим отладки → Ядро: адрес `https://your-core.example.com`, «Проверить». Токен прежний. С 30.09.2026 этот адрес стоит в приложении по умолчанию (`ConnectionSettings.defaultEndpoint`); сохранённый ранее адрес Mac он не перебивает, его меняют в настройках или по USB: `python3 ios/scripts/configure-device.py --device ИДЕНТИФИКАТОР --url https://your-core.example.com`.

## 6. Ограничения облака

- «Работа» в «Штурвале» идёт через сервис `helm` и «Узел» на Mac: Mac включён, «Штурвал» открыт.
- Консоль ядра слушает `127.0.0.1:25452` внутри контейнера и снаружи не видна; история звонков копится в `/data/console`.
- Пульта в ядре нет с 27.09.2026.
- `SKILLS_EXTRA_DIRS` (папки скиллов на Mac) в облаке не задаётся.
