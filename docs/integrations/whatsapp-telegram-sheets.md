# WhatsApp, Telegram и Google Sheets — v1.1

Локальные адаптеры не обращаются к этим сервисам. Проверки с PostgreSQL и подменой HTTP подтверждают поведение кода, но не доступы, одобрение шаблонов или доставку в реальном аккаунте. Перед включением `INTEGRATION_MODE=live` заполните `.env`, выполните `npm run check:production` и контрольные сценарии ниже. Секреты храните вне репозитория; не вставляйте их в клиентский интерфейс.

## WhatsApp

Настройте `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_API_VERSION`. Версию Graph API выберите из поддерживаемых вашим Meta-приложением; проект не подставляет произвольную версию. Публичный HTTPS callback: `APP_BASE_URL/webhooks/whatsapp`; проверка подписки использует GET, события — POST с проверкой `X-Hub-Signature-256` по исходному телу.

Worker проверяет окно при отправке. Запас до границы 24 часов задаётся `WHATSAPP_WINDOW_SAFETY_SECONDS=60`. Внутри окна разрешены текущие ответы, включая подтверждение оплаты; вне окна нужны доступный одобренный шаблон и отдельное согласие клиента. Время повторной доставки webhook не продлевает окно. Отказ «стоп» / «тоқтату» сохраняется отдельно от заказа. Условия платформы: [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).

`WHATSAPP_TEMPLATE_REGISTRY` — JSON одной строкой в `.env`. Ниже только схема заполнения; `replace_*` нельзя использовать как реальные имена или locale, а `available` переключается после проверки в Meta:

```json
{
  "order_paid": {
    "ru": {"name":"replace_paid_ru","locale":"replace_locale","parameters":["orderId"],"available":false},
    "kk": {"name":"replace_paid_kk","locale":"replace_locale","parameters":["orderId"],"available":false}
  },
  "payment_review": {
    "ru": {"name":"replace_review_ru","locale":"replace_locale","parameters":["orderId"],"available":false},
    "kk": {"name":"replace_review_kk","locale":"replace_locale","parameters":["orderId"],"available":false}
  },
  "support_reopen": {
    "ru": {"name":"replace_support_ru","locale":"replace_locale","parameters":[],"available":false},
    "kk": {"name":"replace_support_kk","locale":"replace_locale","parameters":[],"available":false}
  }
}
```

`order_paid` и `payment_review` имеют ровно один текстовый параметр тела — публичный номер заказа. `support_reopen` не имеет параметров: его утверждённый текст приглашает клиента ответить. Произвольный ответ оператора в шаблон не подставляется. Ключ `kk` означает язык интерфейса проекта, а `locale` — фактически доступную и одобренную локаль Meta; отсутствие нужного варианта блокирует отправку без подмены языка. Старый `WHATSAPP_PAID_TEMPLATE` не заменяет реестр.

`ACCEPTED` означает только принятие запроса API; `SENT`, `DELIVERED`, `READ`, `FAILED` приходят отдельными событиями. Таймаут после возможной отправки даёт `UNKNOWN`, без автоматической повторной пересылки. Worker передаёт идентификатор задания как `biz_opaque_callback_data` для корреляции статусов. Проверяйте получение этого поля на выбранной версии API. Ручной повтор `UNKNOWN` может создать дубль.

## Telegram: двусторонний handoff

Создайте бота и закрытый рабочий чат. Настройте `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MANAGER_CHAT_ID`, `TELEGRAM_ALLOWED_MANAGER_IDS` (числовые ID пользователей через запятую) и случайный `TELEGRAM_WEBHOOK_SECRET`. Username менеджера не заменяет ID. Разрешите боту получать команды и ответы Reply в выбранном чате; доступ посторонним к чату закройте.

Через метод `setWebhook` Telegram зарегистрируйте HTTPS URL `APP_BASE_URL/webhooks/telegram`, `secret_token` равный `TELEGRAM_WEBHOOK_SECRET`, `allowed_updates=["message"]`. Backend проверяет заголовок `X-Telegram-Bot-Api-Secret-Token`, чат и отправителя до действий. Повтор `update_id` не создаёт второе сообщение. Контракт метода и механизма Reply: [Telegram Bot API](https://core.telegram.org/bots/api#setwebhook).

1. Клиент выбирает менеджера; создаётся одно активное обращение. Новые клиентские сообщения поступают в тот же ticket, автоматические AI-ответы приостановлены.
2. Менеджер отправляет `/claim <ticketId>`. Параллельное принятие двумя менеджерами имеет одного победителя.
3. Назначенный менеджер использует Telegram **Reply** на уведомлении обращения или пересланном сообщении клиента. Binding `chatId + messageId` определяет адресата. Ответ без Reply, от другого менеджера или в закрытый ticket не отправляется.
4. `/close <ticketId>` закрывает обращение, отменяет ещё не отправленные ответы оператора и возвращает клиенту допустимый шаг по текущему заказу. Финансовый hold этой командой не снимается. Клиент также может явно выбрать возврат к боту.

Поддержаны текстовые ответы; неподдерживаемый тип медиа обозначается явно. Разметка Telegram отключена, пользовательский текст не исполняется как HTML/Markdown. Сообщение «поставлен в очередь» не означает ни принятие API, ни доставку. Вне окна WhatsApp свободный ответ остаётся заблокированным; разрешённый `support_reopen` может пригласить клиента открыть окно новым сообщением.

## Локальная проверка моста

После `npm run demo` откройте `http://localhost:3000`, выберите язык и запросите менеджера. `GET /dev/state` показывает локальные tickets, задания и bindings; имитационные Telegram message ID — числовые строки. По умолчанию чат `-100123456789`, менеджеры `1001` и `1002`. `/dev/*` доступен только в локальном demo-режиме и защищён той же проверкой происхождения запросов, что симулятор WhatsApp.

```sh
curl http://localhost:3000/dev/state
curl -X POST http://localhost:3000/dev/telegram \
  -H 'Content-Type: application/json' \
  -d '{"managerId":"1001","text":"/claim TICKET_UUID"}'
curl -X POST http://localhost:3000/dev/telegram \
  -H 'Content-Type: application/json' \
  -d '{"managerId":"1001","text":"Здравствуйте, помогу с вопросом.","replyToMessageId":"NUMERIC_BINDING_ID"}'
curl -X POST http://localhost:3000/dev/telegram \
  -H 'Content-Type: application/json' \
  -d '{"managerId":"1001","text":"/close TICKET_UUID"}'
```

Замените `TICKET_UUID` и `NUMERIC_BINDING_ID` значениями из состояния. Для проверки дедупликации можно повторить запрос с одинаковым числовым `updateId`. В demo деньги и сообщения во внешние сервисы не отправляются.

## Google Sheets

1. Включите Google Sheets API, создайте service account и предоставьте его email доступ редактора к отдельной таблице. Настройте `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SHEETS_SHEET_ID` (числовой `gid` вкладки), `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_SHEETS_RANGE=Orders!A:Y`. Строки `\n` в приватном ключе поддерживаются.
2. Создайте техническую вкладку **Orders** с минимум 25 столбцами. Вставьте следующую строку с табуляцией в A1; порядок и регистр обязательны:

```text
Order ID	Created At	Paid At	Customer Name	WhatsApp	Phone	Language	City	Address	Product	Discs	Quantity	Unit Price	Total Amount	Currency	Payment Provider	Payment ID	Payment Status	Order Status	Sheet Synced At	Subtotal Amount	Delivery Amount	Delivery Mode	Payment Incident	Order Version
```

3. Защитите **весь лист**, без исключённых диапазонов и без режима «только предупреждение». Оставьте изменение источника service account и ответственному владельцу. Менеджерам используйте доступ просмотра, отдельный `Orders_View` или представления фильтра. Физическая сортировка, вставка и удаление строк в `Orders` недопустимы. Не давайте менеджерам права обходить защиту.
4. Выполните `npm run check:production`: проверяются доступ, числовой sheet ID, название, защита и заголовки. Команда не создаёт вкладку и заголовки. Пустая таблица поэтому не считается подготовленной.

До Google-запроса PostgreSQL выделяет и сохраняет номер строки, начиная со 2. Запись использует [values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update) и [RAW](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption), поэтому пользовательские строки не интерпретируются как формулы. Деньги и количество передаются числами. Повтор после потерянного ответа пишет в тот же диапазон; размер сетки при необходимости увеличивается.

Первичная оплата создаёт строку; смена этапа, возврат или инцидент обновляют её. `Payment ID` относится к основному применённому платежу, второе поступление отражается инцидентом. Сохраняется записанная версия, при изменениях планируется обновление, периодическая сверка исправляет запоздалые старые снимки. Другой Order ID или разрушенная структура блокируют синхронизацию. Исправьте причину и повторите задание через защищённый admin API; не удаляйте binding для слепой повторной записи. PostgreSQL остаётся источником истины; мгновенной общей транзакции с Sheets нет.

Если используются строки v1.0, до запуска worker сделайте резервную копию, остановите записи и выполните `npm run sheets:migrate`. Отчёт `.local/sheet-migration-report.json` показывает сопоставления и конфликты. Только после разбора отчёта без конфликтов применяйте `npm run sheets:migrate -- --apply`. Повторное применение сохраняет корректные bindings и не уменьшает cursor; любой конфликт отменяет весь перенос. Исторические заказы получают `PENDING` и задание обновления A:Y, без повторных платёжных уведомлений. Обновите заголовок K на `Discs` и добавьте U:Y; устраните дубли и отсутствующие строки по данным БД до снятия блокировки исторических заказов. На время каждого запуска миграции записи в лист должны быть остановлены.

## Что проверить с реальными аккаунтами

- RU/KK: ответ внутри окна; платёж вне окна при согласии; отсутствие шаблона; отказ от уведомлений; статус доставки после принятия API.
- Два клиента и два менеджера: `/claim`, корректный Reply, отклонение чужого Reply, повтор update, закрытие ticket, ответ после закрытия, неподдерживаемое медиа.
- Sheets: оплаченный заказ, повтор sync в ту же строку, обновление версии, неверные заголовки и нарушение защиты без перезаписи чужих данных.

Результаты этих проверок сохраните отдельно. Без реальных доступов текущая проверка ограничена локальной готовностью; интеграционная и production-готовность не заявляются.
