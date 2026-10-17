import { createRequire } from 'node:module';
import { inspect } from 'node:util';

export function redactSignalDiagnostics() {
  // libsignal 6 logs entire SessionEntry objects via console.info/warn, outside Pino.
  // Customize inspection only; leave cryptographic state and serialization untouched.
  const requireBaileys = createRequire(import.meta.resolve('@whiskeysockets/baileys'));
  const { SessionRecord } = requireBaileys('libsignal') as {
    SessionRecord: { createEntry?: () => object };
  };
  if (typeof SessionRecord.createEntry !== 'function')
    throw new Error('Unsupported libsignal version: cannot protect session diagnostics');
  const prototype: object = Object.getPrototypeOf(SessionRecord.createEntry());
  Object.defineProperty(prototype, inspect.custom, {
    configurable: true,
    value: () => '[WhatsApp Signal session redacted]',
  });
}
