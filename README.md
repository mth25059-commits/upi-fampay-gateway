# UPI FamPay Gateway

**Take UPI payments that confirm themselves — no payment-gateway account, no
per-transaction cut, no manual "did it arrive?" checking.**

You show the customer a QR. They pay from any UPI app. The bank sends *you* the
usual "you received ₹X" email. This library reads that email, checks it is
genuine, works out which order it pays, and marks the order paid — on its own,
in about fifteen seconds. Zero npm dependencies; it runs on plain Node ≥ 18.

```
   customer                     your app + this library                  you
  ┌────────┐   scans QR   ┌───────────────────────────────┐        ┌─────────┐
  │  UPI   │ ───────────▶ │  unique amount per order       │        │  bank   │
  │  app   │   pays ₹X.yz │  watches your Gmail inbox       │◀───────│  alert  │
  └────────┘              │  DKIM-verifies the alert email  │  "you  │  email  │
                          │  matches ₹X.yz → that order     │ recv'd"└─────────┘
                          │  calls onPaid() → you ship it   │
                          └───────────────────────────────┘
```

> **Independent project.** Not affiliated with FamApp / Fampay or any bank. It
> reads notification emails you already receive in your own inbox; it does not
> connect to any payment provider's systems.

---

## Why it works: the amount *is* the reference

The obvious design puts a random reference in the UPI note field and matches on
it. That breaks in practice — many UPI apps silently drop or rewrite the note,
so it never arrives, and the usual fallback ("accept any payment of the right
amount in a 10-minute window") happily settles the **wrong** customer's order
the moment two people buy the same thing at once.

So the note is not the key here. **The amount is.** Every pending order is quoted
a slightly different number of paise — ₹499.12 for one buyer, ₹499.37 for the
next — unique across all live orders. The amount itself identifies the order, the
note is just belt-and-braces, and two simultaneous buyers can never collide
because they are never quoted the same figure.

The shaved paise always come *off* the price (₹499 → ₹498.xx), never on top, so
nobody is ever charged more than the number on the card.

## Why it's safe: a From header proves nothing

Automatic confirmation makes a **forged** "you received ₹499" email worth real
money to an attacker — and anyone can type your bank's address into a `From:`
line. So the gateway never trusts the From header on its own. A credit is only
believed when the email carries a **DKIM pass for the sender's own domain**, in
an `Authentication-Results` header your mail provider (Gmail) stamped on
delivery. Only the holder of that domain's private key can produce a signature
that verifies against the key published in its DNS — that is what makes the
email mean something. Lookalike domains (`notfamapp.in`), `dkim=fail`, and mail
signed by someone else are all rejected. See [`src/payments.js`](src/payments.js).

Two more guards: every settlement is recorded by `Message-Id` so the same email
re-read on the next scan can't pay twice (a **replay guard**), and a mail with no
`Message-Id` is refused outright because that guard couldn't hold.

---

## Try it in two minutes

```bash
git clone https://github.com/YOUR_USERNAME/upi-fampay-gateway.git
cd upi-fampay-gateway
cp .env.example .env          # edit UPI_ID + UPI_PAYEE_NAME at least
npm start                     # → http://localhost:4400
```

Open the page, enter an amount, and you get a live payment screen with a real,
scannable QR. With no inbox configured, auto-confirm stays off and an **"I paid
(demo)"** button lets you watch the order flip to *paid* without real money. Add
`IMAP_USER` + `IMAP_APP_PASSWORD` and real payments confirm themselves.

Run the test suite (no framework, no deps):

```bash
npm test
```

---

## The four things it asks you for

Everything is set in `.env` (copied from [`.env.example`](.env.example)). Nothing
is ever hard-coded, committed, or sent anywhere but your own machine.

| What | `.env` key | Notes |
|------|-----------|-------|
| **UPI id** — where money lands | `UPI_ID`, `UPI_PAYEE_NAME` | Printed on the QR. A typo pays a stranger. |
| **Inbox mail** — where alerts arrive | `IMAP_USER` | The Gmail address your bank alerts land in. |
| **App password** — to read that inbox | `IMAP_APP_PASSWORD` | A Gmail **App Password**, *not* your login password. Make one at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (needs 2-Step Verification). |
| **Message format** — the alert wording | `IMAP_SENDER` + `src/mailbox.js` | Default is FamApp. A **sanitised sample** of the exact email the parser reads is in [`samples/`](samples/README.md). |

---

## Wiring it into your own app

The gateway keeps no database of its own. You give it a **store** (where orders
live) and an **`onPaid`** callback (what "paid" should do — email a key, unlock a
download, ping you on Telegram). A ready-made in-memory store ships for demos and
tests; swap it for one backed by your real database in production.

```js
import { createGateway, MemoryStore } from 'upi-fampay-gateway';

const gateway = createGateway({
  store: new MemoryStore(),              // ← replace with your DB-backed store
  async onPaid(intent, info) {
    // intent.id is your order id; info has amountPaise, matchedOn, bankRef…
    await shipTheProduct(intent.id);
  },
});

gateway.start();                         // begins watching the inbox

// when a customer checks out:
const { ok, intent, qrSvg, error } = gateway.createIntent({
  id: order.id,
  priceRupees: 499,
});
// show `qrSvg` and `gateway.amountDue(intent)` on your payment page,
// then poll your store for intent.status === 'paid'.
```

### The store contract

Implement these six methods over your own database (see [`src/store.js`](src/store.js)
for the reference `MemoryStore`):

| Method | Does |
|--------|------|
| `reserve(intent)` | Save a new intent. |
| `open()` | Return every intent not yet `paid`/`cancelled`. |
| `get(id)` | One intent by id, or `null`. |
| `markPaid(id, info)` | Mark one paid; return it. |
| `isSettled(messageId)` | Have we already acted on this bank email? |
| `rememberSettled(messageId)` | Record that we have (the replay guard). |

---

## What's in the box

```
src/
  index.js      public entry — createGateway, MemoryStore, and every helper
  gateway.js    wires it together: quotes amounts, runs the inbox poller
  upi.js        UPI request strings + the unique-amount logic   (no I/O)
  qr.js         a QR encoder written from scratch, SVG out      (no deps)
  mailbox.js    a tiny hand-rolled IMAP client + email parser
  payments.js   the DKIM check + which-order-does-this-pay logic (pure)
  config.js     reads .env
examples/
  server.js     a dependency-free demo server
  public/       a clean, reusable payment screen (HTML/CSS/JS)
samples/
  famapp-received.example.eml   a sanitised alert the parser is built against
test/           payments + mailbox test suites (run with `npm test`)
```

Each of the four core files knows nothing about the others' internals:
`mailbox` reads mail, `payments` decides, `upi` computes, `gateway` joins them.
That separation is the point — the security-critical decisions all live in one
small, pure, well-tested file.

---

## Deploying

Run it on anything that keeps a process alive — a small VPS is ideal. It will
**not** auto-confirm on serverless hosts (Vercel/Lambda) because they freeze the
process between requests, so the inbox poller can't run; it detects this and
tells you rather than pretending to watch.

**Security checklist:**

- Keep `.env` out of git (the shipped `.gitignore` already does this) and
  readable only by you (`chmod 600 .env`).
- Never commit a real bank-alert email — only the `*.example.eml` sample.
- The App Password only grants mail access; revoke it any time from your Google
  account without touching your real password.

---

## License

MIT — see [LICENSE](LICENSE). Use it, change it, ship it.

