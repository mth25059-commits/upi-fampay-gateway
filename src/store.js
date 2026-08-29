/**
 * The store: the one thing you plug your own database into.
 *
 * The gateway owns no persistence of its own. It hands you intents to save and
 * asks you to remember which bank mails it has already acted on, and that is the
 * entire contract. A store is any object with these methods:
 *
 *   reserve(intent)            persist a freshly created intent (see shape below)
 *   open()                     → array of every intent not yet paid or cancelled
 *   markPaid(id, info)         mark one paid; return the updated intent (or null)
 *   get(id)                    → one intent by id, or null
 *   isSettled(messageId)       → have we already acted on this bank mail?
 *   rememberSettled(messageId) record that we have, so a re-read cannot double-pay
 *
 * An intent is a plain object the gateway fills in:
 *   { id, priceRupees, amountPaise, listedPaise, reference,
 *     upiId, payee, upiUri, status: 'holding'|'paid'|'cancelled',
 *     setAt, expiresAt, paidInfo? }
 *
 * `MemoryStore` below is a complete, correct implementation that keeps everything
 * in a Map. It is what the example server uses and it is fine for a single
 * process — but it forgets everything on restart, so a real deployment swaps it
 * for one backed by Postgres, SQLite, Redis, a JSON file, whatever you already
 * run. Implement the same six methods and nothing else in the gateway changes.
 */

export class MemoryStore {
  constructor() {
    this.intents = new Map();
    this.seen = [];
    this.seenLimit = 500;
  }

  reserve(intent) {
    this.intents.set(intent.id, intent);
    return intent;
  }

  open() {
    return [...this.intents.values()].filter((i) => i.status === 'holding');
  }

  get(id) {
    return this.intents.get(id) || null;
  }

  markPaid(id, info) {
    const intent = this.intents.get(id);
    if (!intent) return null;
    intent.status = 'paid';
    intent.paidInfo = info;
    return intent;
  }

  isSettled(messageId) {
    if (!messageId) return true; // no id means no guard is possible — refuse
    return this.seen.includes(messageId);
  }

  rememberSettled(messageId) {
    if (!messageId || this.seen.includes(messageId)) return;
    this.seen.push(messageId);
    if (this.seen.length > this.seenLimit) this.seen = this.seen.slice(-this.seenLimit);
  }
}
