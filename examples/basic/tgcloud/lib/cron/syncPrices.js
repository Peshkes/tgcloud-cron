import { db, fetch } from 'sdk';
import { prices } from '../../schema.js';

export default async function (args) {
  const ids = args.coins.join(',');
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
  );
  if (!res.ok) throw new Error(`price API answered ${res.status}`);
  const data = await res.json();

  const now = new Date();
  for (const [symbol, quote] of Object.entries(data)) {
    await db
      .insert(prices)
      .values({ symbol, usd: quote.usd, updatedAt: now })
      .onConflictDoUpdate({ target: prices.symbol, set: { usd: quote.usd, updatedAt: now } })
      .run();
  }
  return { updated: Object.keys(data).length };
}
