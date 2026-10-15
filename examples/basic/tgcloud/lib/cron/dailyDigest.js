import { api, BotApiError, db } from 'sdk';
import { prices, subscribers } from '../../schema.js';

// A job has about 3 s of CPU per call (community measurement), so it sends
// at most `args.limit` messages per run and leaves the rest for the next one.
export default async function (args, tick) {
  const rows = await db.select().from(prices).all();
  if (rows.length === 0) return { sent: 0, reason: 'no prices yet' };

  const text = rows.map((p) => `${p.symbol}: $${p.usd.toFixed(2)}`).join('\n');
  const chats = await db.select().from(subscribers).limit(args.limit).all();

  let sent = 0;
  for (const chat of chats) {
    try {
      await api.sendMessage({
        chat_id: chat.chatId,
        text: `Prices at ${tick.scheduledAt ?? 'now'}\n${text}`,
      });
      sent++;
    } catch (err) {
      // A user who blocked the bot should not stop the digest for everyone else.
      if (!(err instanceof BotApiError)) throw err;
      console.warn(`chat ${chat.chatId}: ${err.message}`);
    }
  }
  return { sent, of: chats.length };
}
