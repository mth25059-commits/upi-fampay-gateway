/**
 * Configuration for the UPI FamPay gateway, read from the environment.
 *
 * Nothing here is a secret in the code — every real value lives in a `.env` file
 * that is gitignored, and `.env.example` documents each key. Copy that file to
 * `.env`, fill in the four things the gateway needs, and you are done:
 *
 *   1. UPI_ID              — where the money should land (e.g. yourname@okhdfcbank)
 *   2. UPI_PAYEE_NAME      — the name a payer sees before they confirm
 *   3. IMAP_USER           — the Gmail inbox the bank alerts arrive in
 *   4. IMAP_APP_PASSWORD   — a Gmail *app password*, not your login password
 *
 * The message format the parser is built against is a bank-alert email; a
 * sanitised example ships in `samples/`. See the README for the full walk-through.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Serverless hosts (Vercel/Lambda) freeze the process between requests, so the
 * mail poller — a background timer — cannot run there. The gateway detects this
 * and refuses to start the poller rather than pretending to watch the inbox.
 */
export const SERVERLESS = Boolean(
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
);

// Tiny .env reader so the gateway runs with a bare `node`. No dotenv dependency.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

export const config = {
  /**
   * Where the money lands. Both of these are printed on the QR every customer
   * scans, so neither is a secret — but a typo in `id` silently sends every
   * payment to a stranger, which is why `src/upi.js` validates the shape before
   * it will build a request URI.
   */
  upi: {
    id: (process.env.UPI_ID || '').trim(),
    payee: (process.env.UPI_PAYEE_NAME || '').trim(),
    refPrefix: (process.env.PAYMENT_REF_PREFIX || 'PAY').trim(),
  },

  /**
   * The Gmail inbox that receives the bank's payment alerts. This is how a sale
   * confirms itself without anyone tapping a button.
   *
   * Leaving `user` or `pass` blank switches automatic confirmation off — the
   * gateway still hands out QR codes, it just will not settle them on its own.
   *
   * `sender` is NOT a security boundary on its own: a From header is trivially
   * forged, so `src/payments.js` additionally requires a DKIM pass for this
   * domain in the Authentication-Results header. `lookbackHours` bounds how far
   * back a scan looks, so an alert from last week cannot be replayed.
   */
  imap: {
    user: (process.env.IMAP_USER || '').trim(),
    pass: (process.env.IMAP_APP_PASSWORD || '').replace(/\s+/g, ''),
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    sender: (process.env.IMAP_SENDER || 'no-reply@famapp.in').trim().toLowerCase(),
    lookbackHours: Number(process.env.IMAP_LOOKBACK_HOURS || 12),
  },

  /**
   * How long a quoted amount stays reserved for one order. A bank alert can take
   * a minute or two to land, and the poller can only settle an order while its
   * window is open — so 15 minutes, not 3.
   */
  paymentWindowMs: Number(process.env.PAYMENT_WINDOW_MINUTES || 15) * 60 * 1000,

  /**
   * Extra time past the deadline that an order still owns its amount, so a credit
   * that lands right on the buzzer cannot be re-attributed to the next buyer who
   * happens to reserve the same figure. Generous on purpose.
   */
  graceMs: Number(process.env.PAYMENT_GRACE_MINUTES || 30) * 60 * 1000,
};

/** A QR can only be drawn once we know where the money is meant to go. */
export const upiEnabled = Boolean(config.upi.id && config.upi.payee);
if (!upiEnabled) {
  console.warn('[config] UPI_ID / UPI_PAYEE_NAME are not set — the gateway cannot build a payment request.');
}

/**
 * Automatic confirmation needs both halves of the mailbox login. Half-configured
 * is the dangerous state, so say which half is missing rather than just "off".
 */
export const autoConfirmEnabled = upiEnabled && Boolean(config.imap.user && config.imap.pass);
if (!autoConfirmEnabled) {
  const missing = [];
  if (!config.imap.user) missing.push('IMAP_USER');
  if (!config.imap.pass) missing.push('IMAP_APP_PASSWORD');
  if (!upiEnabled) missing.push('UPI_ID/UPI_PAYEE_NAME');
  console.warn(
    `[config] automatic payment confirmation is OFF (${missing.join(', ')} missing)` +
      ' — orders are quoted but never settled on their own.',
  );
}
