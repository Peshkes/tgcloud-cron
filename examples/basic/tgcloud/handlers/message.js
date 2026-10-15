import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { subscribers } from '../schema.js';

export default async function (message) {
  const chatId = message.chat.id;
  if (message.text === '/start') {
    await db
      .insert(subscribers)
      .values({ chatId, firstName: message.from?.first_name ?? null, subscribedAt: new Date() })
      .onConflictDoNothing({ target: subscribers.chatId })
      .run();
    await api.sendMessage({
      chat_id: chatId,
      text: 'Subscribed. The digest arrives daily at 09:00 UTC.',
    });
  } else if (message.text === '/stop') {
    await db.delete(subscribers).where(eq(subscribers.chatId, chatId)).run();
    await api.sendMessage({ chat_id: chatId, text: 'Unsubscribed.' });
  }
}
