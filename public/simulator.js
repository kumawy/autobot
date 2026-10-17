'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const messagesElement = $('#messages');
  const input = $('#message-input');
  const phoneInput = $('#phone');
  const notice = $('#notice');
  const stateNames = {
    AWAITING_LANGUAGE: 'Выбор языка',
    MAIN_MENU: 'Главное меню',
    PRODUCT_VIEW: 'Знакомство с товаром',
    DISC_LIST: 'Выбор мелодии',
    AI_QA: 'Отвечаем на вопросы',
    ORDER_NAME: 'Имя получателя',
    ORDER_PHONE: 'Контактный телефон',
    ORDER_CITY: 'Город доставки',
    ORDER_ADDRESS: 'Адрес доставки',
    ORDER_DISC: 'Состав комплекта',
    CANCEL_CONFIRMATION: 'Подтверждение отмены',
    ORDER_QUANTITY: 'Количество комплектов',
    ORDER_CONSENT: 'Уведомления по заказу',
    ORDER_CONFIRMATION: 'Подтверждение заказа',
    PAYMENT_PENDING: 'Ожидаем оплату',
    PAID: 'Заказ оплачен',
    HUMAN_HANDOFF: 'Диалог у менеджера',
  };
  const paymentNames = {
    NOT_CREATED: 'Черновик',
    PENDING: 'Ждём оплату',
    CREATING: 'Создаём ссылку',
    CREATION_UNKNOWN: 'Исход создания неизвестен',
    REVIEW_REQUIRED: 'Нужна проверка',
    EXPIRED: 'Срок завершён',
    REFUND_PENDING: 'Разбор возврата',
    PAID: 'Оплачен',
    FAILED: 'Не оплачен',
    CANCELLED: 'Отменён',
    REFUNDED: 'Возврат',
  };
  const jobNames = {
    WHATSAPP: 'Ответ в WhatsApp',
    WHATSAPP_SEND: 'Сообщение в WhatsApp',
    TELEGRAM_SEND: 'Мост с менеджером',
    PAYMENT_CREATE: 'Создание платежа',
    PAYMENT_RECONCILE: 'Сверка платежа',
    SHEET_SYNC: 'Синхронизация отчёта',
    CREATE_PAYMENT: 'Ссылка на оплату',
    SHEETS: 'Таблица заказов',
    GOOGLE_SHEETS: 'Таблица заказов',
    TELEGRAM: 'Уведомление менеджеру',
  };
  const defaultActionNames = {
    LANG_RU: 'Русский',
    LANG_KK: 'Қазақша',
    MENU_ORDER: 'Заказать',
    MENU_PRODUCT: 'Товар',
    MENU_QUESTION: 'Вопрос',
    MENU_BACK: 'Главное меню',
    ORDER_CONFIRM: 'Подтвердить заказ',
    ORDER_EDIT: 'Изменить',
    ORDER_CANCEL: 'Отменить',
    HUMAN_HANDOFF: 'Менеджер',
    PAYMENT_RETRY: 'Повторить оплату',
    DISC_DONE: 'Состав готов',
    CANCEL_CONFIRM: 'Подтвердить отмену',
    CANCEL_KEEP: 'Сохранить заказ',
    RESUME_BOT: 'Вернуться к боту',
    NOTIFICATIONS_OPT_IN: 'Разрешить уведомления',
    NOTIFICATIONS_SKIP: 'Без уведомлений',
    ORDER_QUANTITY_ONE: '1 комплект',
    BACK: 'Назад',
    PRIVACY: 'Данные и уведомления',
  };
  const timeFormat = new Intl.DateTimeFormat('ru-KZ', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Almaty',
  });
  const amountFormat = new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 });
  let from = '+77070010001';
  try {
    from = sessionStorage.getItem('music-box-demo-phone') || from;
  } catch {
    /* Storage may be disabled. */
  }
  let busy = false;
  let latestRequest = 0;
  let pendingRefreshes = 0;
  let messagesSignature = '';
  let inspectorSignature = '';
  let bridgeState = null;
  let integrations = null;
  let lastSnapshot = null;

  function element(tag, className = '', text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function safeUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, window.location.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url;
    } catch {
      return null;
    }
  }

  function googleSheetUrl(value) {
    const url = safeUrl(value);
    return url?.protocol === 'https:' &&
      url.hostname === 'docs.google.com' &&
      /^\/spreadsheets\/d\/[a-zA-Z0-9_-]+(?:\/|$)/.test(url.pathname)
      ? url
      : null;
  }

  function idleStatus() {
    if (!integrations) return 'Режим обработки сообщений не подтверждён';
    const external = [];
    if (integrations.ai.provider === 'openai') external.push('Вопросы — в OpenAI');
    if (integrations.sheets.enabled && integrations.sheets.provider === 'google')
      external.push('заказы — в Google Sheets');
    if (integrations.whatsapp.provider === 'meta') external.push('сообщения — в WhatsApp');
    if (integrations.telegram.enabled && integrations.telegram.provider === 'telegram')
      external.push('уведомления — в Telegram');
    return external.length
      ? external.join(' · ')
      : 'Сообщения и заказы остаются в локальном приложении';
  }

  function bridgeEnabled() {
    return (
      integrations?.managerHandoffEnabled === true &&
      integrations?.telegram.enabled === true &&
      integrations?.telegram.provider === 'demo'
    );
  }

  function googleSheetSynced(order) {
    return (
      integrations?.sheets.enabled &&
      integrations.sheets.provider === 'google' &&
      order?.sheetSyncStatus === 'SYNCED' &&
      typeof order.sheetRowReference === 'string' &&
      /^(?:'[^']+'|[A-Za-z0-9_ -]+)!A([1-9]\d*):Y\1$/.test(order.sheetRowReference)
    );
  }

  function sheetProviderStatus(snapshot) {
    if (!integrations?.sheets.enabled) return 'Экспорт выключен';
    if (integrations.sheets.provider !== 'google') return 'Локальная демонстрация';
    const confirmed =
      snapshot?.customer &&
      (snapshot.orders || []).some(
        (order) => order.customerId === snapshot.customer.id && googleSheetSynced(order),
      );
    return confirmed
      ? 'Google Sheets · запись заказа подтверждена'
      : 'Google Sheets · ждём записи заказа';
  }

  async function loadIntegrations() {
    try {
      const config = await request('/dev/config');
      if (
        !['demo', 'openai'].includes(config?.ai?.provider) ||
        !['demo', 'google'].includes(config?.sheets?.provider) ||
        !['demo', 'meta'].includes(config?.whatsapp?.provider) ||
        !['demo', 'telegram'].includes(config?.telegram?.provider) ||
        typeof config.sheets.enabled !== 'boolean' ||
        typeof config.telegram.enabled !== 'boolean' ||
        typeof config.managerHandoffEnabled !== 'boolean' ||
        !['mock', 'freedompay'].includes(config.paymentProvider)
      )
        throw new Error('Invalid integration configuration');
      integrations = config;
      const google = config.sheets.enabled && config.sheets.provider === 'google';
      $('#integration-summary').textContent =
        `Ответы — ${config.ai.provider === 'openai' ? 'OpenAI' : 'демо'} · заказы — ${google ? 'Google Sheets' : 'локально'} · оплата — ${config.paymentProvider === 'mock' ? 'тестовая' : 'Freedom Pay'}`;
      $('#integration-state').textContent =
        'Настройки загружены. Доступ к сервисам проверяется при работе.';
      const details = $('#integration-details');
      details.replaceChildren();
      for (const [label, value] of [
        [
          'Ответы',
          config.ai.provider === 'openai'
            ? `OpenAI${typeof config.ai.model === 'string' ? ` · ${config.ai.model.slice(0, 80)}` : ''}`
            : 'Демонстрационный ассистент',
        ],
        ['Таблица', sheetProviderStatus(lastSnapshot)],
        [
          'WhatsApp',
          config.whatsapp.provider === 'demo' ? 'Симулятор, без отправки' : 'Реальный API Meta',
        ],
        [
          'Менеджер',
          !config.managerHandoffEnabled
            ? 'Передача выключена'
            : config.telegram.provider === 'demo'
              ? 'Локальная демонстрация'
              : 'Через Telegram',
        ],
      ]) {
        const detail = element('dd', '', value);
        if (label === 'Таблица') detail.id = 'integration-sheet-status';
        details.append(element('dt', '', label), detail);
      }
      $('#integration-privacy').textContent =
        config.ai.provider === 'openai' || google
          ? 'Для проверки используйте вымышленные данные. Выбранные сервисы получают вопросы или данные заказа.'
          : 'Внешние сервисы отвечают только в явно включённом режиме.';
      const sheet = googleSheetUrl(config.sheets.url);
      const link = $('#google-sheet-link');
      link.hidden = config.sheets.provider !== 'google' || !sheet;
      if (sheet && config.sheets.provider === 'google') link.href = sheet.href;
      else link.removeAttribute('href');
      $('#manager-scenario').hidden = !config.managerHandoffEnabled;
      $('#payment-note').textContent =
        `Оплату подтверждает проверенный серверный результат. Фраза «я оплатил» не меняет статус.${config.paymentProvider === 'mock' ? ' Демо: деньги не списываются.' : ''}`;
    } catch {
      integrations = null;
      $('#integration-summary').textContent = 'Режим сервисов не подтверждён';
      $('#integration-state').textContent =
        'Не удалось загрузить настройки. Обновите страницу перед проверкой подключений.';
      $('#integration-details').replaceChildren();
      $('#integration-privacy').textContent =
        'Не считайте этот режим полностью локальным, пока настройки недоступны.';
      $('#google-sheet-link').hidden = true;
      $('#google-sheet-link').removeAttribute('href');
      $('#manager-scenario').hidden = true;
    }
    if (!busy) $('#status-line').textContent = idleStatus();
    inspectorSignature = '';
    if (lastSnapshot) render(lastSnapshot);
    updateBridgeAvailability();
  }

  function textWithLinks(target, value) {
    const text = String(value ?? '');
    const pattern = /https?:\/\/[^\s<>]+/g;
    let position = 0;
    for (const match of text.matchAll(pattern)) {
      target.append(document.createTextNode(text.slice(position, match.index)));
      const candidate = match[0].replace(/[),.;!?]+$/, '');
      const url = safeUrl(candidate);
      if (url) {
        const link = element('a', '', candidate);
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        target.append(link, document.createTextNode(match[0].slice(candidate.length)));
      } else target.append(document.createTextNode(match[0]));
      position = match.index + match[0].length;
    }
    target.append(document.createTextNode(text.slice(position)));
  }

  function showError(error) {
    notice.textContent =
      error instanceof Error ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
    notice.hidden = false;
  }

  function setConnection(connected) {
    const badge = $('#connection-badge');
    badge.textContent = connected ? 'Сервер на связи' : 'Нет связи';
    badge.classList.toggle('offline', !connected);
  }

  function setBusy(value) {
    busy = value;
    document
      .querySelectorAll(
        '#send-button, #new-client, #identity-form button, [data-message], [data-action], .payment-actions button, #release-handoff',
      )
      .forEach((button) => {
        button.disabled = value;
      });
    phoneInput.disabled = value;
    updateBridgeAvailability();
    $('#status-line').textContent = value ? 'Ассистент обрабатывает сообщение…' : idleStatus();
  }

  async function request(path, payload) {
    const response = await fetch(path, {
      method: payload === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(65_000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        result && typeof result.message === 'string'
          ? result.message
          : `Приложение вернуло ошибку ${response.status}. Проверьте локальный сервер.`;
      throw new Error(message);
    }
    return result;
  }

  async function refresh(quiet = false) {
    if (quiet && pendingRefreshes > 0) return;
    pendingRefreshes += 1;
    const token = ++latestRequest;
    try {
      const result = await request(`/dev/state?from=${encodeURIComponent(from)}`);
      if (token !== latestRequest) return;
      setConnection(true);
      render(result);
    } catch (error) {
      if (token !== latestRequest) return;
      setConnection(false);
      if (!quiet) showError(error);
    } finally {
      pendingRefreshes -= 1;
    }
  }

  async function sendMessage(payload) {
    if (busy) return;
    setBusy(true);
    notice.hidden = true;
    const token = ++latestRequest;
    try {
      const result = await request('/dev/simulate-whatsapp', {
        from,
        id: `simulator.${crypto.randomUUID()}`,
        ...payload,
      });
      if (token !== latestRequest) return;
      setConnection(true);
      render(result, true);
      if (payload.text && input.value.trim() === payload.text) {
        input.value = '';
        resizeInput();
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
      input.focus({ preventScroll: true });
    }
  }

  async function simulatePayment(attemptId, status) {
    if (busy) return;
    setBusy(true);
    notice.hidden = true;
    ++latestRequest;
    try {
      await request(`/dev/mock-payment/${encodeURIComponent(attemptId)}`, { status });
      await refresh();
      messagesElement.scrollTop = messagesElement.scrollHeight;
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function actionButton(action, list = false) {
    const button = element('button', list ? 'message-action list-option' : 'message-action');
    button.type = 'button';
    button.dataset.action = String(action.id);
    button.disabled = busy;
    button.append(element('span', '', action.title || action.id));
    if (list && action.description) button.append(element('small', '', action.description));
    button.addEventListener('click', () =>
      sendMessage({ type: 'interactive', actionId: String(action.id) }),
    );
    return button;
  }

  function buildMessage(message, actionNames) {
    const inbound = message.direction === 'inbound';
    const wrapper = element('article', `message ${inbound ? 'inbound' : 'outbound'}`);
    const bubble = element('div', 'bubble');
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    let text = message.content ?? payload.text ?? payload.caption ?? '';
    if (inbound && (message.type === 'interactive' || message.type === 'button')) {
      text =
        actionNames[text] ||
        (/^DISC_disc_/.test(text)
          ? 'Мелодия выбрана'
          : /^REMOVE_DISC_/.test(text)
            ? 'Убрать мелодию'
            : /^DISCS_PAGE_/.test(text)
              ? 'Другая страница каталога'
              : text);
    }
    if (!inbound && payload.type === 'image') {
      const url = safeUrl(payload.url);
      if (url) {
        const image = element('img', 'message-image');
        image.src = url.href;
        image.alt =
          typeof payload.caption === 'string' ? payload.caption : 'Фото музыкальной шкатулки';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener(
          'error',
          () => image.replaceWith(element('div', 'image-placeholder', 'Фото недоступно')),
          { once: true },
        );
        bubble.append(image);
      }
    }
    if (payload.type === 'template' && !text)
      text = `Шаблон: ${payload.name}\n${Array.isArray(payload.parameters) ? payload.parameters.join('\n') : ''}`;
    if (text) {
      const body = element('div', 'message-body');
      textWithLinks(body, text);
      bubble.append(body);
    }
    if (!inbound && payload.type === 'buttons' && Array.isArray(payload.buttons)) {
      const actions = element('div', 'message-actions');
      payload.buttons
        .filter((action) => action && typeof action.id === 'string')
        .forEach((action) => actions.append(actionButton(action)));
      bubble.append(actions);
    }
    if (!inbound && payload.type === 'list' && Array.isArray(payload.rows)) {
      const toggle = element('button', 'list-toggle', `☷  ${payload.button || 'Выбрать'}`);
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      const options = element('div', 'list-options');
      options.hidden = true;
      payload.rows
        .filter((row) => row && typeof row.id === 'string')
        .forEach((row) => options.append(actionButton(row, true)));
      toggle.addEventListener('click', () => {
        options.hidden = !options.hidden;
        toggle.setAttribute('aria-expanded', String(!options.hidden));
      });
      bubble.append(toggle, options);
    }
    if (!bubble.childNodes.length) bubble.append(element('div', 'message-body', 'Сообщение'));
    const meta = element('div', 'message-meta');
    const date = new Date(message.createdAt);
    meta.append(
      element(
        'span',
        '',
        inbound ? 'Вы' : payload.purpose === 'operator_reply' ? 'Менеджер' : 'Music Box',
      ),
    );
    if (!Number.isNaN(date.getTime())) meta.append(element('time', '', timeFormat.format(date)));
    if (!inbound && message.deliveryStatus) {
      const status = String(message.deliveryStatus).toUpperCase();
      const labels = {
        ACCEPTED: 'Принято API',
        SENT: 'Отправлено',
        DELIVERED: 'Доставлено',
        READ: 'Прочитано',
        FAILED: 'Ошибка отправки',
        UNKNOWN: 'Исход неизвестен',
        BLOCKED: 'Отправка заблокирована',
        PENDING: 'В очереди',
      };
      meta.append(element('span', 'delivery-label', labels[status] || status));
    }
    wrapper.append(bubble, meta);
    return wrapper;
  }

  function renderEmptyChat() {
    const empty = element('div', 'empty-chat');
    empty.append(
      element('div', 'empty-chat-icon', '♫'),
      element('div', 'eyebrow', 'ВАШ АССИСТЕНТ ГОТОВ'),
      element('h3', '', 'Хороший заказ начинается\nс простого вопроса.'),
      element(
        'p',
        '',
        'Напишите сообщение. Ассистент предложит язык и поможет выбрать музыкальную шкатулку.',
      ),
    );
    const start = element('button', 'button', 'Узнать цену шкатулки  →');
    start.type = 'button';
    start.dataset.message = 'Сколько стоит музыкальная шкатулка?';
    start.disabled = busy;
    start.addEventListener('click', () =>
      sendMessage({ type: 'text', text: start.dataset.message }),
    );
    empty.append(start);
    messagesElement.replaceChildren(empty);
  }

  function statusBadge(status, names = paymentNames) {
    const kind = ['PAID', 'DONE'].includes(status)
      ? 'positive'
      : [
            'FAILED',
            'CANCELLED',
            'REFUNDED',
            'UNKNOWN',
            'BLOCKED',
            'DEAD',
            'REVIEW_REQUIRED',
            'CREATION_UNKNOWN',
          ].includes(status)
        ? 'negative'
        : status === 'NOT_CREATED'
          ? 'neutral'
          : '';
    return element('span', `badge ${kind}`, names[status] || status || '—');
  }

  function renderOrder(orders, customer) {
    const container = $('#order-content');
    container.replaceChildren();
    $('#order-count').textContent = orders.length ? String(orders.length).padStart(2, '0') : '—';
    const order = orders.find((item) => item.id === customer?.currentOrderId) || orders[0];
    if (!order) {
      const empty = element('div', 'empty-order');
      empty.append(
        element('span', '', '◇'),
        element('strong', '', 'Здесь появится заказ'),
        element('p', '', 'Оформите заказ в чате —\nвсе детали соберутся здесь.'),
      );
      container.append(empty);
      return null;
    }
    const identity = element('div', 'order-identity');
    identity.append(element('strong', '', order.publicOrderId), statusBadge(order.paymentStatus));
    const total = element(
      'div',
      'order-total',
      amountFormat.format(Number(order.totalAmount) || 0),
    );
    total.append(element('small', '', '₸'));
    container.append(
      identity,
      element(
        'p',
        'order-product',
        `${order.quantity || 1} × ${order.productName || 'Музыкальная шкатулка'}`,
      ),
      total,
    );
    const details = element('dl', 'order-details');
    for (const [label, value] of [
      ['Получатель', order.recipientName],
      ['Телефон', order.recipientPhone],
      ['Город', order.city],
      ['Адрес', order.address],
      [
        'Состав',
        Array.isArray(order.packageSnapshot?.discs)
          ? order.packageSnapshot.discs.map((disc) => disc.title).join(', ')
          : order.discTitle || (order.selectedDiscIds || []).join(', ') || order.discId,
      ],
      [
        'Товары',
        `${amountFormat.format(Number(order.subtotalAmount ?? order.totalAmount) || 0)} ₸`,
      ],
      [
        'Доставка',
        order.deliveryMode === 'PAID_SEPARATELY'
          ? 'Оплачивается отдельно'
          : order.deliveryMode === 'INCLUDED'
            ? 'Включена в цену'
            : order.deliveryMode === 'FIXED_PREPAID'
              ? `${amountFormat.format(Number(order.deliveryAmount) || 0)} ₸ по ссылке`
              : 'Тариф не согласован',
      ],
      [
        'Этап',
        {
          DRAFT: 'Черновик',
          AWAITING_CONFIRMATION: 'Проверка данных',
          AWAITING_PAYMENT: 'Ожидает оплаты',
          PAID: 'Оплачен',
          PROCESSING: 'В обработке',
          SHIPPED: 'Отправлен',
          COMPLETED: 'Завершён',
          CANCELLED: 'Отменён',
          REFUND_PENDING: 'Разбор возврата',
          REFUNDED: 'Возврат учтён',
        }[order.orderStatus] || order.orderStatus,
      ],
      [
        'Снимок',
        order.checkoutFrozenAt
          ? `Зафиксирован · версия ${order.contentVersion || 1}`
          : 'Редактируемый черновик',
      ],
    ]) {
      if (value) details.append(element('dt', '', label), element('dd', '', value));
    }
    if (details.childNodes.length) container.append(details);
    if (order.deliverySnapshot?.terms?.ru)
      container.append(element('p', 'delivery-terms', order.deliverySnapshot.terms.ru));
    if (order.fulfillmentHold || order.reviewRequired || order.paymentReviewRequired) {
      container.append(
        element(
          'p',
          'order-hold',
          'Исполнение приостановлено. Менеджер должен проверить финансовый инцидент. Поступивший платёж остаётся в учёте.',
        ),
      );
    }
    container.append(element('p', 'total-caption', 'Сумма выше — сумма по платёжной ссылке.'));
    if (['PAID', 'REFUNDED', 'REFUND_PENDING'].includes(order.paymentStatus)) {
      const sync = element('div', 'sheet-sync');
      const demoRecord = String(order.sheetRowReference || '').startsWith('demo:');
      const google = integrations?.sheets.enabled && integrations?.sheets.provider === 'google';
      let title = 'Запись заказа';
      let detail;
      let state = 'pending';
      if (order.sheetSyncStatus === 'SYNCED' && demoRecord) {
        title = 'Проверено локально';
        detail = 'Этот заказ сохранён в демо-отчёте. Запись в Google Sheets не подтверждена.';
      } else if (googleSheetSynced(order)) {
        title = 'Заказ записан в Google Sheets';
        detail = 'Успешная запись подтверждена для этого заказа.';
        state = 'synced';
      } else if (!integrations) {
        detail = 'Настройки таблицы недоступны. Заказ сохранён в приложении.';
      } else if (!integrations.sheets.enabled) {
        title = 'Экспорт выключен';
        detail = 'Заказ сохранён в приложении. Отправка в таблицу отключена.';
      } else if (
        ['BLOCKED', 'FAILED', 'ERROR', 'LEGACY_RECONCILIATION_REQUIRED'].includes(
          order.sheetSyncStatus,
        )
      ) {
        title = 'Запись в таблицу требует проверки';
        detail = 'Заказ и оплата сохранены. Проверьте подключение и доступ к таблице.';
        state = 'blocked';
      } else if (order.sheetSyncStatus === 'SYNCED') {
        title = 'Запись отмечена в отчёте';
        detail = 'Текущий режим не подтверждает подключение к Google Sheets.';
      } else {
        title = google ? 'Ожидает записи в Google Sheets' : 'Ожидает записи в демо-отчёт';
        detail = 'Заказ и оплата сохранены. Статус обновится после обработки.';
      }
      sync.classList.add(state);
      sync.append(element('strong', '', title), element('p', '', detail));
      container.append(sync);
    }

    const attempt = Array.isArray(order.paymentAttempts)
      ? order.paymentAttempts.find((item) => item.status === 'PENDING' && item.provider === 'mock')
      : null;
    if (attempt && order.paymentStatus !== 'PAID') {
      const actions = element('div', 'payment-actions');
      actions.append(element('p', '', 'Симуляция ответа платёжной системы'));
      for (const [status, label, className] of [
        ['SUCCESS', '✓  Успешная оплата', 'button-pay'],
        ['FAILED', 'Ошибка оплаты', 'button-fail'],
      ]) {
        const button = element('button', `button full-width ${className}`, label);
        button.type = 'button';
        button.disabled = busy;
        button.addEventListener('click', () => simulatePayment(attempt.id, status));
        actions.append(button);
      }
      container.append(actions);
    }
    const paymentUrl = safeUrl(order.paymentUrl);
    if (paymentUrl && order.paymentStatus !== 'PAID') {
      const link = element('a', 'payment-link', 'Открыть страницу оплаты ↗');
      link.href = paymentUrl.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      container.append(link);
    }
    return order;
  }

  function renderJobs(jobs) {
    $('#jobs-count').textContent = String(jobs.length);
    const container = $('#jobs-content');
    container.replaceChildren();
    if (!jobs.length) {
      container.append(
        element('p', 'jobs-empty', 'Ответы, платежи и уведомления появятся по мере общения.'),
      );
      return;
    }
    for (const job of jobs.slice(-7).reverse()) {
      const row = element('div', 'job-row');
      const name = element(
        'div',
        'job-name',
        jobNames[job.kind || job.type] || job.kind || job.type,
      );
      if (job.attempts > 0) name.append(element('small', 'job-retry', `Попыток: ${job.attempts}`));
      row.append(
        name,
        statusBadge(job.status, {
          DONE: 'Выполнено',
          PENDING: 'В очереди',
          PROCESSING: 'В работе',
          RETRY: 'Повтор позже',
          UNKNOWN: 'Исход неизвестен',
          BLOCKED: 'Заблокировано',
          DEAD: 'Нужен оператор',
          FAILED: 'Ошибка',
        }),
      );
      container.append(row);
    }
  }

  function updateBridgeAvailability() {
    const ticket = bridgeState?.ticket;
    const actor = $('#demo-manager').value;
    const assigned = ticket?.status === 'ASSIGNED' && String(ticket.assignedManagerId) === actor;
    const enabled = bridgeEnabled();
    $('#ticket-claim').disabled = busy || !enabled || !ticket || ticket.status !== 'OPEN';
    $('#ticket-close').disabled = busy || !enabled || !assigned;
    $('#telegram-send').disabled = busy || !enabled || !assigned || !bridgeState?.binding;
    $('#demo-manager').disabled = busy || !enabled;
  }

  function renderBridge(snapshot) {
    const ticket = (snapshot.handoffs || []).find((item) => item.status !== 'CLOSED');
    const binding = (snapshot.telegramBindings || []).find(
      (item) => item.ticketId === ticket?.id && item.customerId === snapshot.customer?.id,
    );
    if (bridgeState?.ticket?.id !== ticket?.id) {
      $('#bridge-status').textContent = '';
      $('#telegram-reply').value = '';
    }
    bridgeState = { ticket, binding };
    $('#telegram-demo').hidden =
      !bridgeEnabled() || !ticket || !Array.isArray(snapshot.demoManagers);
    $('#telegram-binding').textContent = binding
      ? `Reply связан с сообщением ${binding.messageId} текущего обращения.`
      : 'Ждём создания связи с сообщением менеджеру.';
    const log = $('#telegram-log');
    log.replaceChildren();
    for (const message of (snapshot.telegramMessages || [])
      .filter((item) => item.payload?.ticketId === ticket?.id)
      .slice(0, 3)) {
      const row = element('div', 'telegram-log-item');
      row.append(element('p', '', message.payload?.text || 'Сообщение обращения'));
      row.append(
        statusBadge(message.status, {
          DONE: 'Принято API в DEMO',
          PENDING: 'В очереди',
          PROCESSING: 'Отправляется',
          RETRY: 'Повтор позже',
          UNKNOWN: 'Исход неизвестен',
          BLOCKED: 'Заблокировано',
          DEAD: 'Нужна проверка',
        }),
      );
      log.append(row);
    }
    updateBridgeAvailability();
  }

  async function telegramAction(kind) {
    if (busy || !bridgeEnabled() || !bridgeState?.ticket) return;
    const ticket = bridgeState.ticket;
    const reply = $('#telegram-reply').value.trim();
    if (kind === 'reply' && (!reply || !bridgeState.binding)) return;
    const payload = {
      managerId: $('#demo-manager').value,
      text: kind === 'reply' ? reply : `/${kind} ${ticket.id}`,
      updateId: Date.now() * 1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 1000),
      ...(kind === 'reply' ? { replyToMessageId: String(bridgeState.binding.messageId) } : {}),
    };
    setBusy(true);
    notice.hidden = true;
    try {
      const response = await request('/dev/telegram', payload);
      const labels = {
        CLAIMED: 'Диалог назначен выбранному менеджеру.',
        CLOSED: 'Обращение закрыто.',
        QUEUED: 'Ответ поставлен в очередь. Принятие API и доставка отражаются отдельно в чате.',
        DUPLICATE: 'Повтор уже обработанного действия.',
        TICKET_NOT_ASSIGNED: 'Обращение назначено другому менеджеру либо закрыто.',
        TICKET_UNAVAILABLE: 'Обращение уже занято или закрыто.',
        BINDING_NOT_FOUND: 'Связь Reply не найдена. Обновите страницу.',
        REPLY_REQUIRED: 'Нужна связь Reply с сообщением обращения.',
      };
      $('#bridge-status').textContent =
        labels[response.action] || response.action || 'Действие обработано.';
      if (kind === 'reply' && response.action === 'QUEUED') $('#telegram-reply').value = '';
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function renderIncidents(incidents) {
    const open = incidents.filter((item) => item.status !== 'RESOLVED');
    $('#incidents-panel').hidden = open.length === 0;
    $('#incidents-count').textContent = String(open.length);
    const content = $('#incidents-content');
    content.replaceChildren();
    const labels = {
      DUPLICATE_PAYMENT: 'Несколько поступлений по заказу',
      LATE_PAYMENT: 'Оплата после отмены',
      UNKNOWN_PAYMENT: 'Платёж без связи с заказом',
      AMOUNT_MISMATCH: 'Сумма не совпала',
      CURRENCY_MISMATCH: 'Валюта не совпала',
    };
    for (const incident of open) {
      const item = element('div', 'incident-item');
      const reason = incident.reason || incident.type || 'Платёж требует проверки';
      item.append(element('strong', '', labels[reason] || reason));
      if (incident.actualAmount !== undefined && incident.actualAmount !== null)
        item.append(
          element(
            'p',
            '',
            `Фактически: ${amountFormat.format(Number(incident.actualAmount))} ${incident.actualCurrency || 'KZT'}`,
          ),
        );
      item.append(
        element('small', '', 'Решение принимает менеджер. Автоматического возврата нет.'),
      );
      content.append(item);
    }
  }

  function render(snapshot, scroll = false) {
    if (!snapshot || !Array.isArray(snapshot.messages))
      throw new Error('Сервер вернул неожиданный формат данных.');
    lastSnapshot = snapshot;
    const sheetStatus = $('#integration-sheet-status');
    if (sheetStatus) sheetStatus.textContent = sheetProviderStatus(snapshot);
    const nextMessages = JSON.stringify(snapshot.messages);
    if (nextMessages !== messagesSignature) {
      const wasNearBottom =
        messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight <
        80;
      messagesSignature = nextMessages;
      if (!snapshot.messages.length) renderEmptyChat();
      else {
        const actionNames = { ...defaultActionNames };
        for (const order of snapshot.orders || []) {
          for (const disc of order.packageSnapshot?.discs || [])
            actionNames[`DISC_${disc.id}`] = disc.title;
          if (order.discId && order.discTitle)
            actionNames[`DISC_${order.discId}`] = order.discTitle;
        }
        for (const message of snapshot.messages) {
          for (const action of [
            ...(message.payload?.buttons || []),
            ...(message.payload?.rows || []),
          ]) {
            if (action && typeof action.id === 'string')
              actionNames[action.id] = action.title || action.id;
          }
        }
        messagesElement.replaceChildren(
          ...snapshot.messages.map((message) => buildMessage(message, actionNames)),
        );
      }
      if (scroll || wasNearBottom) messagesElement.scrollTop = messagesElement.scrollHeight;
    }
    const nextInspector = JSON.stringify([
      snapshot.customer,
      snapshot.orders,
      snapshot.jobs,
      snapshot.handoffs,
      snapshot.incidents,
      snapshot.telegramBindings,
      snapshot.telegramMessages,
      snapshot.demoManagers,
      integrations,
    ]);
    if (nextInspector === inspectorSignature) return;
    inspectorSignature = nextInspector;
    const customer = snapshot.customer;
    $('#conversation-state').textContent = customer
      ? stateNames[customer.conversationState] || customer.conversationState
      : 'Ожидаем первое сообщение';
    $('#state-code').textContent = customer?.conversationState || 'НОВЫЙ КЛИЕНТ';
    $('#language-label').textContent =
      customer?.preferredLanguage === 'ru'
        ? 'Русский'
        : customer?.preferredLanguage === 'kk'
          ? 'Қазақша'
          : 'Язык ещё не выбран';
    const order = renderOrder(snapshot.orders || [], customer);
    renderJobs(snapshot.jobs || []);
    $('#consent-status').textContent = customer?.notificationConsent
      ? 'Разрешены сообщения по заказам. Реклама не включена.'
      : customer?.optedOutAt
        ? 'Последующие уведомления отключены по запросу. Заказ сохранён.'
        : 'Согласие на последующие сообщения не получено. Разрешение — отдельной кнопкой в чате.';
    $('#privacy-version').textContent = customer?.privacyNoticeVersion
      ? `Показано уведомление: ${customer.privacyNoticeVersion}`
      : 'Уведомление о данных ещё не показано.';
    renderIncidents(snapshot.incidents || []);
    const ticket = (snapshot.handoffs || []).find((item) => item.status !== 'CLOSED');
    const ticketDetails = $('#handoff-details');
    ticketDetails.replaceChildren();
    if (ticket) {
      ticketDetails.append(
        element(
          'p',
          'ticket-code',
          `Обращение ${String(ticket.id).slice(0, 8)} · ${ticket.status === 'ASSIGNED' ? 'Принято менеджером' : 'Ожидает менеджера'}`,
        ),
      );
    }

    const stage =
      order?.paymentStatus === 'PAID'
        ? 4
        : ['PENDING', 'CREATING', 'CREATION_UNKNOWN', 'REVIEW_REQUIRED'].includes(
              order?.paymentStatus,
            )
          ? 3
          : order
            ? 2
            : customer
              ? 1
              : 0;
    $('#journey')
      .querySelectorAll('li')
      .forEach((item, index) => {
        item.classList.toggle('active', index < stage);
        item.classList.toggle('complete', index + 1 < stage);
      });
    $('#handoff-panel').hidden = customer?.conversationState !== 'HUMAN_HANDOFF';
    $('#handoff-description').textContent =
      integrations?.managerHandoffEnabled === false
        ? 'Передача менеджеру выключена. Продолжите с ассистентом — данные заказа сохранятся.'
        : 'AI-ответы приостановлены. Платёжные события продолжают учитываться. Можно явно вернуться к боту.';
    renderBridge(snapshot);
  }

  function changeIdentity(value) {
    if (busy) return;
    const normalized = value.replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{9,14}$/.test(normalized)) {
      showError(new Error('Введите телефон с кодом страны, например +77070010001.'));
      return;
    }
    from = normalized.startsWith('+') ? normalized : `+${normalized}`;
    phoneInput.value = from;
    $('#chat-phone').textContent = from;
    try {
      sessionStorage.setItem('music-box-demo-phone', from);
    } catch {
      /* Continue without persistence. */
    }
    messagesSignature = '';
    inspectorSignature = '';
    notice.hidden = true;
    render({ customer: null, messages: [], orders: [], jobs: [], handoffs: [] });
    void refresh();
  }

  function resizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(125, input.scrollHeight)}px`;
  }
  $('#message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text) void sendMessage({ type: 'text', text });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('#message-form').requestSubmit();
    }
  });
  input.addEventListener('input', resizeInput);
  $('#identity-form').addEventListener('submit', (event) => {
    event.preventDefault();
    changeIdentity(phoneInput.value);
  });
  $('#new-client').addEventListener('click', () => {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % 10_000_000;
    changeIdentity(`+7707${String(random).padStart(7, '0')}`);
    input.value = '';
    resizeInput();
  });
  document
    .querySelectorAll('[data-message]')
    .forEach((button) =>
      button.addEventListener('click', () =>
        sendMessage({ type: 'text', text: button.dataset.message }),
      ),
    );
  document.querySelectorAll('[data-fill]').forEach((button) =>
    button.addEventListener('click', () => {
      input.value = button.dataset.fill;
      resizeInput();
      input.focus({ preventScroll: true });
    }),
  );
  $('#demo-manager').addEventListener('change', updateBridgeAvailability);
  $('#ticket-claim').addEventListener('click', () => telegramAction('claim'));
  $('#ticket-close').addEventListener('click', () => telegramAction('close'));
  $('#telegram-reply-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void telegramAction('reply');
  });
  $('#release-handoff').addEventListener('click', () =>
    sendMessage({ type: 'text', text: 'вернуться к боту' }),
  );
  window.setInterval(() => {
    if (!busy && document.visibilityState === 'visible') void refresh(true);
  }, 2000);
  document.addEventListener('visibilitychange', () => {
    if (!busy && document.visibilityState === 'visible') void refresh(true);
  });
  changeIdentity(from);
  void loadIntegrations();
})();
