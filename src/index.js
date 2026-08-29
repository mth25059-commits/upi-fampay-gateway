/**
 * UPI FamPay Gateway — public entry point.
 *
 * A small, dependency-free toolkit for taking UPI payments that confirm
 * themselves: it quotes each order a unique amount, shows a QR, and watches a
 * Gmail inbox for the bank's own alert to mark the order paid — with a DKIM check
 * so a forged alert cannot buy anything for free.
 *
 * Typical use:
 *   import { createGateway, MemoryStore } from 'upi-fampay-gateway';
 *   const gw = createGateway({ store: new MemoryStore(), onPaid });
 *
 * The individual pieces are exported too, for building something custom.
 */

export { createGateway } from './gateway.js';
export { MemoryStore } from './store.js';

export { config, autoConfirmEnabled, upiEnabled, SERVERLESS } from './config.js';

export {
  toPaise,
  rupees,
  formatAmount,
  displayAmount,
  makeReference,
  referencePattern,
  pickAmount,
  buildUpiUri,
} from './upi.js';

export { toSvg as qrSvg, matrix as qrMatrix } from './qr.js';
export { parseMessage, scan } from './mailbox.js';
export {
  senderIsAuthentic,
  matchCredit,
  settlePayment,
  describeSettlement,
} from './payments.js';
