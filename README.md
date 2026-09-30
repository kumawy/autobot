# AI WhatsApp Sales Agent · v1.1

Локальный проект по `SPEC.md` и `PATCH-v1.1.md`: продажи музыкальной шкатулки на русском и казахском, оформление заказа, платёжные попытки, Google Sheets и передача диалога менеджеру.

По умолчанию `INTEGRATION_MODE=demo`: демонстрационный каталог и локальные имитации интеграций. Денежные средства не списываются, сообщения в настоящие WhatsApp и Telegram не отправляются. Демо-условия комплектации и доставки явно отмечены в `data/business.json` и не разрешают реальные платежи.

Для настоящих OpenAI и тестового номера Meta добавлен `INTEGRATION_MODE=staging`: PostgreSQL остаётся источником данных, оплата — только mock, Telegram и Google Sheets отключены по умолчанию. Конфигурация и запуск описаны в [STAGING_DEPLOYMENT.md](docs/STAGING_DEPLOYMENT.md). Локальный симулятор сохраняет прежний режим.

## Быстрый запуск

Требуется Node.js **24.21.0** (зафиксирован в `.nvmrc`, Docker и CI).

```sh
nvm install
nvm use
npm ci
npm run demo
```

Открыть **http://localhost:3000**. Команда создаёт локальный `.env` с уникальными секретами, запускает PostgreSQL на `127.0.0.1:55432`, применяет миграции, проверяет каталог и запускает два процесса: HTTP-приложение и worker. Данные сохраняются в `.local/postgres`. Для остановки — Ctrl+C. Повторный запуск сохраняет заказы.

Если Node управляется другим способом, установите указанную в `.nvmrc` версию. Не копируйте локальные секреты в production.

В симуляторе можно пройти заказ до тестовой оплаты, увидеть состояния очереди и финансовые инциденты, переключить клиента, запросить менеджера и проверить Telegram Reply от демонстрационных менеджеров 1001/1002.

Для браузерного показа с **настоящим OpenAI и Google Sheets** используйте `npm run demo:connected` и [инструкцию подключения](docs/CONNECTED_DEMO.md). Этот режим работает на `http://localhost:3001`, хранит заказы в отдельной локальной PostgreSQL и не требует аккаунтов WhatsApp/Telegram. Обычный `npm run demo` по-прежнему использует локальные имитации.

## Что реализовано

- RU/KK wizard, выбор дисков и комплектации, отдельная стоимость доставки, версия уведомления о данных и отдельное согласие на инициативные сообщения.
- Кнопки с непрозрачными одноразовыми идентификаторами, привязанные к клиенту, заказу и версии. Отмена требует подтверждения; выпущенная платёжная попытка сохраняет свой состав и сумму.
- Durable inbox/outbox в PostgreSQL, короткие транзакции, lease и проверка владельца задания. AI и HTTP работают вне транзакций.
- `CREATION_UNKNOWN` и `UNKNOWN` после неоднозначных сетевых ошибок. Автоматическое повторное создание платежа или повторная отправка неизвестного сообщения запрещены.
- Проверенные callbacks и сверка Freedom Pay, точное сравнение сумм, платёжные инциденты, hold, сохранение этапа исполнения заказа. Браузерный redirect оплату не подтверждает.
- Google Sheets: 25 столбцов, закреплённая строка заказа, `values.update` с `RAW`, версии, проверка структуры и сверка.
- Окно WhatsApp проверяется перед отправкой; вне окна используются только настроенные одобренные шаблоны при наличии согласия. Доставка отслеживается отдельно от принятия API.
- Telegram: разрешённые числовые ID менеджеров, `/claim`, Reply по сохранённой привязке, `/close`, возврат клиента к боту. Только текст.
- Защищённая диагностика, heartbeat, управляемая очистка переписки и миграция прежних данных.

## Команды

```sh
npm run check            # TypeScript, ESLint, unit + реальные PostgreSQL-тесты
npm run build
npm run demo:connected   # Браузер + настоящий OpenAI, отдельная локальная база
npm run sheets:setup     # Подготовка Orders; сначала указать DOTENV_CONFIG_PATH
npm run check:production # Проверка настроек/доступа; в demo ожидается exit 1
npm run db:migrate
npm run db:validate      # Проверка Prisma schema
npm run db:check         # SELECT 1, безопасный результат без URL
npm run test:integration # Временные отдельные PostgreSQL, без настоящих API
npm run seed
npm run dev              # HTTP отдельно для своей PostgreSQL
npm run worker:dev       # Worker отдельно
npm start                # Собранный HTTP
npm run worker           # Собранный worker
```

`docker compose up --build` запускает app, worker и PostgreSQL в демонстрационном режиме. Контейнерный запуск требует установленного Docker; локальный `npm run demo` обходится без него.

Основные настройки: `.env.example`, `data/business.json`, `data/product.ru.json`, `data/product.kk.json`, `data/discs.json`, `data/faq.*.json`. Реальную бизнес-конфигурацию утверждает владелец. При её ошибках закрывается checkout; приём уже существующих платежей продолжает работать.

## Документация

- [Переходы диалога](docs/state-transitions.md)
- [Эксплуатация, очереди, миграции и восстановление](docs/operations.md)
- [Freedom Pay](docs/integrations/freedompay.md)
- [WhatsApp, Telegram и Google Sheets](docs/integrations/whatsapp-telegram-sheets.md)
- [Проверка готовности production](docs/production-readiness.md)
- [Фактически выполненные проверки](docs/verification.md)
- [OpenAI и ограничения tools](docs/openai.md)
- [Запуск development/staging с Supabase](docs/STAGING_DEPLOYMENT.md)
- [Отдельная проверка OpenAI](docs/OPENAI_STAGING.md)
- [Проверка тестового номера Meta](docs/META_WHATSAPP_DEMO.md)

Проверка OpenAI выполняется отдельно: `DOTENV_CONFIG_PATH=.env.staging.local npm run --silent test:openai`. Успешные локальные тесты не заменяют проверку Supabase, доставки Meta и доступа к остальным аккаунтам. Статус фактически выполненных проверок указан в документации; секреты в репозитории отсутствуют.
