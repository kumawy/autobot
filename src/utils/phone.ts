import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Accept formatted international numbers and Kazakhstan national notation. */
export function normalizePhone(value: string): string | null {
  const input = value.trim();
  if (!input || input.length > 40 || !/^[+\d\s().-]+$/.test(input)) return null;
  const phone = parsePhoneNumberFromString(input, 'KZ');
  return phone?.isValid() ? phone.number : null;
}
