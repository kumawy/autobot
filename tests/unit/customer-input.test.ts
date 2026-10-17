import { describe, expect, it } from 'vitest';
import {
  isCityName,
  isCustomerQuestion,
  isOrderConfirmation,
  isRecipientName,
} from '../../src/modules/conversation/customer-input.js';

describe('customer questions interrupted during checkout', () => {
  it.each([
    'У вас есть красная шкатулка',
    'Это оригинал',
    'А это оригинал',
    'Хочу узнать цену',
    'Хотел узнать цену',
    'Хотела бы уточнить условия',
    'Интересует цена',
    'Интересуют другие цвета',
    'Подскажите стоимость',
    'Цена комплекта',
    'Привет сколько стоит',
    'А эта модель деревянная',
    'Шкатулка деревянная',
    'Я оплатил',
    'Гарантийный срок',
    'Платёжная ссылка',
    'Білгім келеді',
    'Сіздерде басқа түстер бар',
    'Бұл түпнұсқа',
    'Екі жиынтық қанша тұрады',
  ])('keeps this message out of recipient and city fields: %s', (text) => {
    expect(isCustomerQuestion(text)).toBe(true);
    expect(isRecipientName(text)).toBe(false);
    expect(isCityName(text)).toBe(false);
  });

  it.each(['ул. Доставки 10', 'улица Доставки 10', 'проспект Гарантии 12'])(
    'preserves a street address containing a business term: %s',
    (text) => {
      expect(isCustomerQuestion(text)).toBe(false);
    },
  );
  it('recognizes an explicit question even when the message also contains a street address', () => {
    expect(isCustomerQuestion('улица Доставки 10 сколько будет доставка')).toBe(true);
  });
});

describe('recipient and city field validation', () => {
  it.each([
    'да',
    'нет',
    'ок',
    'OK',
    'Спасибо!',
    'да, спасибо',
    'рахмет',
    'иә',
    'ия',
    'жоқ',
    'жарайды',
    'Привет',
    'Добрый день',
    'сәлеметсіз бе',
  ])('does not save an acknowledgement as a name or city: %s', (text) => {
    expect(isRecipientName(text)).toBe(false);
    expect(isCityName(text)).toBe(false);
  });
  it.each([
    'Арман',
    'А Кунанбаев',
    'А. Кунанбаев',
    'Касым-Жомарт Кемельұлы Тоқаев',
    'Джон Рональд Руэл Толкин',
    'Мария де ла Крус',
    'О’Коннор',
    'Анна-Мария',
    'Оплатбек',
  ])('preserves a legitimate recipient name: %s', (text) => {
    expect(isCustomerQuestion(text)).toBe(false);
    expect(isRecipientName(text)).toBe(true);
  });
  it.each(['Алматы', 'Усть-Каменогорск', 'Нижний Новгород', 'New York', 'г. Алматы'])(
    'preserves a legitimate city name: %s',
    (text) => {
      expect(isCustomerQuestion(text)).toBe(false);
      expect(isCityName(text)).toBe(true);
    },
  );
  it.each(['Тут написано очень длинное постороннее предложение', 'Арман 123', 'Арман\0'])(
    'rejects unrelated prose or malformed names: %s',
    (text) => {
      expect(isRecipientName(text)).toBe(false);
      expect(isCityName(text)).toBe(false);
    },
  );
});

describe('safe natural confirmation', () => {
  it.each(['Да, всё верно', 'бәрі дұрыс', 'иә, бәрі дұрыс', 'подтверждаю заказ'])(
    'accepts an unconditional approval: %s',
    (text) => expect(isOrderConfirmation(text)).toBe(true),
  );
  it.each(['да, но адрес другой', 'да?', 'давайте обсудим', 'верно ли указана цена'])(
    'requires another explicit approval after a conditional or uncertain reply: %s',
    (text) => expect(isOrderConfirmation(text)).toBe(false),
  );
});
