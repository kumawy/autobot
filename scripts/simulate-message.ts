import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

interface SnapshotMessage {
  id: string;
  direction: string;
  type: string;
  content?: string | null;
  payload?: {
    type: string;
    text?: string;
    caption?: string;
    url?: string;
    buttons?: { id: string; title: string }[];
    rows?: { id: string; title: string; description?: string }[];
  };
}
interface Snapshot {
  customer?: { conversationState: string; preferredLanguage?: string | null } | null;
  messages: SnapshotMessage[];
  orders?: {
    publicOrderId: string;
    totalAmount: number;
    paymentStatus: string;
    paymentUrl?: string | null;
  }[];
}
interface Options {
  from: string;
  baseUrl: string;
  text?: string;
  action?: string;
  id?: string;
  interactive: boolean;
  help: boolean;
}

function parseArguments(args: string[]): Options {
  const options: Options = {
    from: '+77070010001',
    baseUrl: 'http://localhost:3000',
    interactive: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help' || key === '-h') {
      options.help = true;
      continue;
    }
    if (key === '--interactive' || key === '-i') {
      options.interactive = true;
      continue;
    }
    if (!['--from', '--base-url', '--text', '--action', '--id'].includes(key || ''))
      throw new Error(`Неизвестный аргумент: ${key}. Используйте --help.`);
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Укажите значение ${key}.`);
    if (key === '--from') options.from = value;
    else if (key === '--base-url') options.baseUrl = value;
    else if (key === '--text') options.text = value;
    else if (key === '--action') options.action = value;
    else if (key === '--id') options.id = value;
  }
  const url = new URL(options.baseUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'CLI симулятор работает только с локальным сервером: localhost, 127.0.0.1 или [::1].',
    );
  }
  if (!/^\+?[1-9]\d{9,14}$/.test(options.from))
    throw new Error('Укажите телефон с кодом страны, например +77070010001.');
  return options;
}

const usage = `Локальный симулятор Music Box. Реальные сообщения не отправляются.

  npm run simulate -- --text 'Сколько стоит?' --from '+77070010001'
  npm run simulate -- --action LANG_RU --from '+77070010001'
  npm run simulate -- --text 'Сколько стоит?' --action LANG_RU
  npm run simulate -- --interactive

Если указаны --text и --action, сначала отправляется текст, затем нажатие кнопки.
Без аргументов открывается интерактивный диалог; пустой первый ввод — «Привет!».

  --from       Телефон клиента (по умолчанию +77070010001)
  --base-url   Локальный сервер (по умолчанию http://localhost:3000)
  --text       Текст сообщения
  --action     ID интерактивной кнопки или строки списка
  --id         ID сообщения для проверки повторной доставки webhook
  --interactive, -i  Продолжить общение в терминале

Команды диалога: /action ID, /state, /exit.
`;

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    stdout.write(usage);
    return;
  }
  const seen = new Set<string>();
  async function api(path: string, payload?: Record<string, unknown>): Promise<Snapshot> {
    const response = await fetch(new URL(path, options.baseUrl), {
      method: payload ? 'POST' : 'GET',
      headers: {
        ...(payload ? { 'content-type': 'application/json' } : {}),
        origin: new URL(options.baseUrl).origin,
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(65_000),
      redirect: 'error',
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const details =
        typeof data === 'object' && data !== null && 'message' in data
          ? String(data.message)
          : `HTTP ${response.status}`;
      throw new Error(details);
    }
    if (
      typeof data !== 'object' ||
      data === null ||
      !('messages' in data) ||
      !Array.isArray(data.messages)
    )
      throw new Error('Неожиданный ответ локального сервера.');
    return data as Snapshot;
  }
  function print(snapshot: Snapshot): void {
    for (const message of snapshot.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const payload = message.payload;
      const body =
        message.content ||
        payload?.text ||
        payload?.caption ||
        (payload?.url ? `[Фото] ${payload.url}` : `[${message.type}]`);
      stdout.write(`\n${message.direction === 'inbound' ? 'Вы' : 'Music Box'}: ${body}\n`);
      for (const action of [...(payload?.buttons || []), ...(payload?.rows || [])]) {
        const description =
          'description' in action && typeof action.description === 'string'
            ? action.description
            : '';
        stdout.write(`  [${action.id}] ${action.title}${description ? ` — ${description}` : ''}\n`);
      }
    }
    stdout.write(`\nСостояние: ${snapshot.customer?.conversationState || 'НОВЫЙ КЛИЕНТ'}\n`);
    const order = snapshot.orders?.[0];
    if (order)
      stdout.write(
        `Заказ ${order.publicOrderId} · ${order.totalAmount} KZT · ${order.paymentStatus}${order.paymentUrl ? `\nОплата: ${order.paymentUrl}` : ''}\n`,
      );
  }
  async function send(text?: string, actionId?: string, id?: string): Promise<void> {
    print(
      await api('/dev/simulate-whatsapp', {
        from: options.from,
        id: id || `cli.${randomUUID()}`,
        ...(actionId ? { type: 'interactive', actionId } : { type: 'text', text }),
      }),
    );
  }
  stdout.write(`Music Box · локальный клиент ${options.from}\n`);
  if (options.text !== undefined) await send(options.text, undefined, options.id);
  if (options.action !== undefined)
    await send(
      undefined,
      options.action,
      options.text !== undefined && options.id ? `${options.id}.action` : options.id,
    );
  const interactive =
    options.interactive || (options.text === undefined && options.action === undefined);
  if (!interactive) return;
  if (!stdin.isTTY) throw new Error('Для неинтерактивного запуска укажите --text или --action.');
  stdout.write('\nВведите текст или /action ID. /state — состояние, /exit — выход.\n');
  const readline = createInterface({ input: stdin, output: stdout });
  let first = options.text === undefined && options.action === undefined;
  try {
    for (;;) {
      const answer = (await readline.question(first ? '\nВы [Привет!]: ' : '\nВы: ')).trim();
      if (answer === '/exit' || answer === '/quit') break;
      if (answer === '/state') {
        print(await api(`/dev/state?from=${encodeURIComponent(options.from)}`));
        continue;
      }
      if (answer.startsWith('/action ')) {
        await send(undefined, answer.slice(8).trim());
        first = false;
        continue;
      }
      if (!answer && !first) continue;
      await send(answer || 'Привет!');
      first = false;
    }
  } finally {
    readline.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Симулятор: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
