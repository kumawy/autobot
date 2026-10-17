(() => {
  let token = '';
  let polling = false;
  let timer;
  const status = document.getElementById('status');
  const qr = document.getElementById('qr');
  const reconnect = document.getElementById('reconnect');
  const labels = {
    stopped: 'Подключение ещё не запущено',
    connecting: 'Подключаемся…',
    qr: 'Отсканируйте QR-код с телефона',
    connected: 'WhatsApp подключён',
    reconnecting: 'Восстанавливаем связь…',
    logged_out:
      'Телефон отключил сессию. Нажмите «Восстановить подключение» и привяжите устройство заново.',
    number_mismatch:
      'Подключён другой номер. Нажмите «Восстановить подключение» и отсканируйте QR-код нужным номером.',
    session_busy: 'Этот номер уже обслуживается другим процессом. Ожидаем освобождения сессии.',
    storage_error: 'Не удалось сохранить или прочитать сессию. Проверяем связь с базой.',
  };
  async function request(path, method = 'GET') {
    const response = await fetch(`/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'Неверный ключ администратора'
          : `Запрос не выполнен (${response.status})`,
      );
    return response.json();
  }
  async function refresh() {
    if (!token || polling) return;
    polling = true;
    try {
      const state = await request('/whatsapp/status');
      status.textContent = `${labels[state.state] || state.state}${state.number ? ` · ${state.number}` : ''}`;
      reconnect.hidden = false;
      qr.hidden = !state.qrAvailable;
      if (state.qrAvailable) {
        const image = await request('/whatsapp/qr');
        qr.src = image.dataUrl;
      } else qr.removeAttribute('src');
      const customers = await request('/whatsapp/conversations');
      const list = document.getElementById('conversations');
      list.replaceChildren();
      for (const customer of customers) {
        const item = document.createElement('li');
        const paused = customer.conversationState === 'HUMAN_HANDOFF';
        item.append(
          document.createTextNode(`${customer.whatsappId} · ${paused ? 'Менеджер' : 'Бот'} `),
        );
        const button = document.createElement('button');
        button.textContent = paused ? 'Вернуть боту' : 'Поставить на паузу';
        button.onclick = async () => {
          button.disabled = true;
          try {
            await request(
              `/customers/${customer.id}/${paused ? 'release-handoff' : 'pause-bot'}`,
              'POST',
            );
            await refresh();
          } catch (error) {
            status.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        };
        item.append(button);
        list.append(item);
      }
    } catch (error) {
      status.textContent = error.message;
      qr.hidden = true;
      qr.removeAttribute('src');
    } finally {
      polling = false;
    }
  }
  document.getElementById('login').onsubmit = async (event) => {
    event.preventDefault();
    clearInterval(timer);
    token = document.getElementById('token').value.trim();
    document.getElementById('token').value = '';
    await refresh();
    timer = setInterval(refresh, 5000);
  };
  reconnect.onclick = async () => {
    reconnect.disabled = true;
    try {
      await request('/whatsapp/reconnect', 'POST');
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      reconnect.disabled = false;
    }
  };
})();
