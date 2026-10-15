import { index, integer, real, table, text } from 'sdk/db';

export const subscribers = table('subscribers', {
  chatId: integer('chat_id').primaryKey(),
  firstName: text('first_name'),
  subscribedAt: integer('subscribed_at', { mode: 'timestamp' }).notNull(),
});

export const prices = table(
  'prices',
  {
    symbol: text('symbol').primaryKey(),
    usd: real('usd').notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({ updatedIdx: index('prices_updated_at').on(t.updatedAt) }),
);
