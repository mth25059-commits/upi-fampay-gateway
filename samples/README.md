# The message format the parser reads

Automatic confirmation works by reading the **bank / UPI app's own notification
email** — the "you received ₹X" alert. The parser in [`../src/mailbox.js`](../src/mailbox.js)
is built against the exact wording of that mail, so the wording matters more than
anything else here.

`famapp-received.example.eml` in this folder is a **sanitised** FamApp alert: real
in shape (headers, MIME structure, quoted-printable body, the `Authentication-Results`
line the security check depends on) but with every personal value replaced by
`X`s and `9`s. It is safe to commit and it is what the test suite runs against.

## What the parser looks for

From a real FamApp credit alert:

```
Subject: You received ₹1.07 in your FamX account
Body:    Hey <you>, You have successfully received ₹1.07 from <payer> at
         06:29 PM IST, 27 August 2026 with transaction id FMPIB... . Your
         updated balance is ₹9.99. UTR: 999999999999. Purpose: Paid via CRED.
```

Three details shape the whole design:

1. **`₹1.07` — the paise are printed in full.** The unique last-two-digits trick
   only works because the alert shows them. If your bank ever rounds the amount,
   set `STEP_PAISE = 10` in `src/upi.js` (one digit) and matching keeps working.
2. **"Purpose: Paid via CRED" sits inside a _credit_.** So direction is read from
   "you **received**" / "you **paid**", never from the bare word "paid".
3. **"updated balance is ₹9.99" is a second, larger figure.** The amount is read
   only immediately after "received", so the balance is never mistaken for it.

## Using this with a different bank or UPI app

If your alerts come from a different sender (not FamApp), you change two things:

- `IMAP_SENDER` in `.env` — the address the alerts come from.
- The credit regexes in `src/mailbox.js` (`RECEIVED`, `IS_CREDIT`, `IS_DEBIT`) —
  match your provider's wording.

Then drop a sanitised sample of *your* provider's alert in this folder and point
the tests at it, so you know the parser reads it correctly before a real rupee
depends on it.

## Getting a real sample to build against (kept private, never committed)

1. Open the notification mail in Gmail (web).
2. Three-dot menu → **Show original** → **Download Original**.
3. Save it somewhere **outside this repo** (it carries a real name, amount and UTR).
4. Blank out the personal bits, keeping the same shape (`X`s, `9`s). **Do not**
   remove the `From:`, `Subject:`, `Date:`, `Authentication-Results:` or
   `DKIM-Signature:` headers — the sender check rests on them.

`*.eml` is gitignored except this one `*.example.eml`, so a real download you drop
here will not be committed by accident.
