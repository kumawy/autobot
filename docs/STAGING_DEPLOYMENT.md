# Development / staging: Supabase, OpenAI и тестовый WhatsApp

Этап сохраняет архитектуру v1.1: PostgreSQL хранит клиентов, заказы, неизменяемые платёжные попытки, inbox/outbox и ключи дедупликации. HTTP принимает подписанные webhook, отдельный worker обрабатывает события и отправляет ответы. В staging используются реальные OpenAI и тестовый номер Meta, демонстрационный каталог и **только mock-оплата**.

| Режим                          | OpenAI / WhatsApp  | Оплата                    | Sheets / Telegram                   | Симулятор                 |
| ------------------------------ | ------------------ | ------------------------- | ----------------------------------- | ------------------------- |
| `demo`                         | Локальные адаптеры | Mock                      | Локальные адаптеры, можно отключить | Только локальный `/dev/*` |
| `staging`                      | Настоящие API      | Только mock               | Отключены по умолчанию              | Отсутствует               |
| `live` + `NODE_ENV=production` | Настоящие API      | Freedom Pay без test mode | По явной конфигурации               | Всегда отсутствует        |

`NODE_ENV=development` для staging — намеренный выбор: прежний production guard запрещает mock. Это не снятие ограничений production. `INTEGRATION_MODE=staging` дополнительно запрещает Freedom Pay и любые `/dev/*`. Для production остаются отдельные требования к бизнес-данным, HTTPS и секретам.

## 1. Файл окружения

Используйте Node.js **24.21.0**, указанную в `.nvmrc`. Создайте `.env.staging.local` из `.env.example`, только если такого файла ещё нет, и установите `chmod 600 .env.staging.local`. `.env`, `.env.local`, `.env.*.local` исключены из Git и Docker context; `.env.example` содержит только примеры.

Заполните файл локально. Присланные в переписке секреты следует заменить новыми. Для `ADMIN_TOKEN`, `MOCK_PAYMENT_SECRET` и `WHATSAPP_VERIFY_TOKEN` нужны разные случайные строки, а не примеры из `.env.example`.

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
APP_BASE_URL=https://your-staging-host.example
INTEGRATION_MODE=staging
PAYMENT_PROVIDER=mock
FREEDOMPAY_TEST_MODE=true
DEV_ROUTES_ENABLED=false
GOOGLE_SHEETS_ENABLED=false
TELEGRAM_ENABLED=false
MANAGER_HANDOFF_ENABLED=false
OPENAI_MODEL=gpt-4.1-mini
```

В этом же файле задаются `DATABASE_URL`, `DIRECT_URL`, `OPENAI_API_KEY` и все `WHATSAPP_*` из [инструкции Meta](META_WHATSAPP_DEMO.md). Модель читается из окружения; `gpt-4.1-mini` — выбранное для этого этапа значение. Пустые обязательные настройки дают контролируемую ошибку запуска. Для отдельного теста OpenAI настройки БД и Meta не нужны.

Каждая команда ниже использует `DOTENV_CONFIG_PATH=.env.staging.local`. Уже экспортированные переменные имеют приоритет; не экспортируйте значения другого окружения в этом терминале. `npm run demo` продолжает использовать локальный `.env` и встроенную PostgreSQL.

## 2. Supabase / PostgreSQL

Используйте отдельную staging-базу. Проект подключается через Prisma 7 и `@prisma/adapter-pg`, Supabase SDK не нужен. Перед созданием таблиц отключите Data API в выделенном Supabase-проекте, поскольку приложение использует только серверное PostgreSQL-подключение. Миграции создают таблицы в `public`; существующие Supabase-проекты могут автоматически выдавать Data API ролям права на новые таблицы. Настройка описана в [Securing your API → Disable the Data API](https://supabase.com/docs/guides/api/securing-your-api#disable-the-data-api). Для общей базы, где Data API нужен другим приложениям, сначала изолируйте доступ к этим таблицам.

| Переменная     | Для чего              | Подключение Supabase при IPv4          |
| -------------- | --------------------- | -------------------------------------- |
| `DATABASE_URL` | HTTP и worker         | Shared transaction pooler, порт `6543` |
| `DIRECT_URL`   | Prisma CLI и миграции | Shared session pooler, порт `5432`     |

Возьмите обе строки из **Connect** своего проекта. Вставьте реальный пароль вместо заглушки; специальные символы пароля должны быть percent-encoded. Сохраните корректный `postgres.<project-ref>`, имя базы и регион из панели. Для обеих строк задайте `sslmode=verify-full` (через `?` либо `&` в зависимости от наличия параметров). Не отключайте проверку сертификата при ошибке TLS: проверьте CA и окружение. [Официальное руководство подключения](https://supabase.com/docs/guides/database/connecting-to-postgres).

В Prisma 7 CLI берёт `DIRECT_URL` из `prisma.config.ts`; runtime использует только `DATABASE_URL`. При отсутствии `DIRECT_URL` допустим прямой/local/session `DATABASE_URL`, но известный transaction pooler для миграций отклоняется. У native `pg` здесь нет именованных prepared statements; параметр `pgbouncer=true` допустим, но размер пула задаётся адаптером (`max:10` на процесс), а не параметром Prisma URL. Учитывайте два процесса и лимиты своего проекта. [Prisma + Supabase](https://supabase.com/docs/guides/database/prisma).

База и роль подключения должны сохранять UTC. Приложение передаёт startup option UTC для обычной PostgreSQL, но на transaction pooler нельзя полагаться на сохранение состояния сессии. Сверьте `SHOW timezone` через выбранную staging-базу. Код использует транзакционные advisory locks; постоянные session locks ему не нужны.

```sh
nvm use
npm install
DOTENV_CONFIG_PATH=.env.staging.local npm run db:validate
DOTENV_CONFIG_PATH=.env.staging.local npm run db:check
DOTENV_CONFIG_PATH=.env.staging.local npm run db:migrate
DOTENV_CONFIG_PATH=.env.staging.local npm run seed
```

`db:check` выполняет только `SELECT 1`. Успех: `Database connection: OK`, exit 0. Ошибка: `Database connection: FAILED (категория)`, exit 1, без URL, пароля, исходного driver error или stack trace. `db:validate` проверяет схему, **не соединение**. `db:migrate` — обычный `prisma migrate deploy` со всеми существующими миграциями. `db push`, reset, очистка и пересоздание таблиц не используются. Перед миграцией непустой базы нужна актуальная резервная копия.

## 3. Проверить OpenAI отдельно

```sh
DOTENV_CONFIG_PATH=.env.staging.local npm run --silent test:openai
```

Команда делает один небольшой реальный запрос без данных клиентов и выводит только ответ или безопасный код ошибки. Она запрещена в production и не включена в обычные тесты. Полное описание — [OPENAI_STAGING.md](OPENAI_STAGING.md).

## 4. Запустить HTTP и worker

```sh
npm run build
DOTENV_CONFIG_PATH=.env.staging.local npm start
```

Во втором терминале:

```sh
DOTENV_CONFIG_PATH=.env.staging.local npm run worker
```

Для разработки вместо собранных процессов доступны `npm run dev` и `npm run worker:dev` с тем же `DOTENV_CONFIG_PATH`. Нужны **оба** процесса: HTTP подтверждает долговечную запись webhook в БД, worker отвечает клиенту. Перезапуск не стирает inbox/outbox, состояние заказа и ключи дедупликации.

```sh
curl --fail http://127.0.0.1:3001/health
```

При доступной БД: HTTP 200 `{"status":"ok","database":"connected"}`. При ошибке: HTTP 503 `{"status":"degraded","database":"disconnected"}`. `/ready` даёт ту же проверку. Health не вызывает OpenAI, Meta или платёжного провайдера и не подтверждает работу worker; его heartbeat и очередь смотрят через защищённый `/admin/status`.

Для Meta нужен публичный HTTPS reverse proxy или туннель к HTTP-процессу. Укажите его origin в `APP_BASE_URL`; путь callback — `/webhooks/whatsapp`. Staging не стартует с HTTP, localhost, путём или секретом в `APP_BASE_URL`, чтобы бот не выдавал непригодные ссылки. Proxy должен сохранять исходное тело POST и заголовок подписи. `/admin/*` лучше дополнительно ограничить сетью оператора. Порядок подписки и реального RU/KK теста — [META_WHATSAPP_DEMO.md](META_WHATSAPP_DEMO.md).

## 5. Контейнер или сервер без привязки к провайдеру

Dockerfile запускает процесс от пользователя `node`, слушает `HOST`/`PORT`, включает Prisma CLI и проверяет `/health`. Он не содержит `.env` или секретов. Для staging переопределите `NODE_ENV` из production-default образа. Пример для сервера с локальным HTTPS reverse proxy:

```sh
docker build -t autobot:staging .
docker run --rm --env-file .env.staging.local -e NODE_ENV=development autobot:staging node node_modules/prisma/build/index.js migrate deploy
docker run -d --name autobot-http --init --restart unless-stopped --env-file .env.staging.local -e NODE_ENV=development -e HOST=0.0.0.0 -e PORT=3000 -p 127.0.0.1:3001:3000 autobot:staging
docker run -d --name autobot-worker --init --restart unless-stopped --env-file .env.staging.local -e NODE_ENV=development --health-cmd='node dist/src/jobs/health.js' --health-timeout=10s autobot:staging node dist/src/worker.js
```

Миграции — отдельный шаг release до запуска новых процессов, а не параллельная команда каждого worker. Исходный `docker-compose.yml` остаётся автономным локальным demo с собственной PostgreSQL. В среде без Docker выполните установку, сборку и миграции теми же npm-командами; настройте менеджер процессов на `npm start` и `npm run worker`, передайте секреты через окружение и выставьте `HOST=0.0.0.0` за HTTPS proxy. Docker build/runtime в этой рабочей среде не проверены, поскольку Docker не установлен; загрузка Prisma config в структуре runtime-образа проверена отдельно.

## 6. Оплата и необязательные интеграции

Mock checkout в staging — `/mock-payment/{attemptId}?expires=...&token=...`, срок ссылки 24 часа. Подпись привязана к конкретной попытке; неправильная или просроченная ссылка возвращает 403 до чтения заказа. GET только показывает тестовую страницу. POST создаёт подписанное mock-событие и проводит его через существующую проверку платежа; worker отправляет подтверждение. Повтор не создаёт второй успешный платёж. Сам текст «я оплатил» и redirect статус не меняют. Ссылка даёт право симулировать результат конкретной попытки, поэтому её не публикуют. В production эти маршруты отсутствуют.

При `MANAGER_HANDOFF_ENABLED=false` клиент получает локализованный ответ о недоступности менеджера, текущий шаг заказа сохраняется. Новые handoff не создаются. Для настоящего Telegram включите `TELEGRAM_ENABLED=true`; для передачи человеку дополнительно включите `MANAGER_HANDOFF_ENABLED=true`, задайте bot token, числовой manager chat ID, `TELEGRAM_ALLOWED_USER_IDS` и webhook secret. Прежнее имя `TELEGRAM_ALLOWED_MANAGER_IDS` поддерживается как alias. При выключенном bridge Telegram webhook возвращает 404.

Для Sheets включите `GOOGLE_SHEETS_ENABLED=true` и заполните spreadsheet ID, service-account email/key; подготовьте лист по [инструкции интеграции](integrations/whatsapp-telegram-sheets.md). Выключенные Sheets/Telegram не вызывают внешние API. Сохранённые задания получают `BLOCKED` с кодом `GOOGLE_SHEETS_DISABLED`/`TELEGRAM_DISABLED`, без ложного `SYNCED` или отправленного Telegram-сообщения. Оплата и заказ остаются в PostgreSQL. После включения выполните управляемый retry/resync через административные маршруты; автоматической массовой отправки накопленного нет.

## 7. Проверки и границы этапа

```sh
npm run db:validate
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build
```

Обычные тесты используют отдельные временные PostgreSQL и HTTP-заглушки, не staging-базу. Миграционные subprocess получают локальный URL явно, независимо от `DIRECT_URL` владельца. Проверяются RU/KK, подписи, durable ACK, дедупликация, mock checkout, отключённые интеграции и production guards.

На 1 октября 2026 года отдельный реальный OpenAI запрос прошёл. Supabase и Meta ещё не проверены: в локальных DB URL остаётся пароль-заглушка, отсутствуют настройки Meta и публичный HTTPS адрес. Деплой и настоящий WhatsApp диалог не выполнялись. Следующий этап — заполнить оставшиеся настройки, применить миграции к выделенной staging-базе и пройти реальный тест на разрешённом номере Meta. Production WhatsApp и реальные платежи в этот этап не входят.
