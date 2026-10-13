# Migration and decommission plan

**From:** PHP 5.x (ext/mysql, ext/soap, sessions stored in local files) on Apache with mod_rewrite (.htaccess) on host app01. MySQL 5.1 MyISAM/latin1 on db01.internal.example. PHPMailer 5.2.9 over SMTP. Native PHP SoapClient for the PayGate gateway. PDFs on local disk at /var/www/invoicing/storage/pdf. jQuery 1.7.2 frontend. System crontab for the www-data user. Inbound access is controlled by a firewall IP allowlist.  
**To:** Cloudflare Workers with nodejs_compat. Workers is not a full Node 22 runtime, so code is written in TypeScript and built and tested with Node 22 tooling. Components:
- Postgres (managed), reached through Hyperdrive with the `pg` driver.
- R2 for invoice PDFs.
- Cron Triggers plus Cloudflare Queues for the overdue-reminder job.
- Workers TCP `connect()` to SMTP on port 587, or a transactional email API.
- SOAP envelopes built by hand and sent with `fetch` to PayGate.
- Cloudflare Access for staff SSO, and an Access service token or WAF IP rule for the ERP.
- Wrangler secrets for credentials.
- Postgres point-in-time recovery (PITR) for backups.
- Workers Logs / Tail with alerting.  
**Generated:** 2026-10-13  
**Run:** 27 turns, 398.4 s, estimated cost $1.3962, model claude-opus-5-5, 0 tool call(s) denied by the read-only guard  
**Citations:** 201 of 201 verified against the repo on disk

## Summary

This is an internal PHP 5 / MySQL 5.1 invoicing app (MyISAM, latin1). Staff log in, list invoices and charge cards through a SOAP payment gateway. An accounting ERP polls a JSON status feed at /status.json. A nightly cron job adds a late fee and emails each overdue customer with a PDF attached. The app becomes one Cloudflare Worker (TypeScript with nodejs_compat) using Postgres through Hyperdrive, R2 for PDFs, Cron Triggers plus Queues for the reminder job, Cloudflare Access for staff and ERP authentication, and Wrangler secrets. The main risks:
- The late-fee job is not idempotent and compounds every night, so it must never run in both systems on the same business day.
- The charge endpoint has no auth, no double-charge guard and no transaction.
- An unknown system outside this repo creates invoices, customers and users, and must be found and pointed at Postgres before cut-over.

## Inventory

### Components

| Component | Kind | Description | Evidence |
|---|---|---|---|
| Staff invoice list page | web-ui | Requires a PHP session (redirects to /login.php if there is none). Lists the 100 invoices with the latest due dates and a 'Charge card' button on each row. DB values are echoed without escaping (XSS). Also served at /invoices through a rewrite rule. | [`public/index.php:4`](app/public/index.php#L4), [`public/index.php:8`](app/public/index.php#L8), [`public/index.php:20`](app/public/index.php#L20), [`public/.htaccess:2`](app/public/.htaccess#L2) |
| Login page | web-ui | Form POST of email and password. Compares an unsalted MD5 hash with users.password_md5 and sets $_SESSION['user_id']. The session id is not regenerated after login, and there is no logout or CSRF protection. Sessions are stored as files on app01. | [`public/login.php:8`](app/public/login.php#L8), [`public/login.php:9`](app/public/login.php#L9) |
| Charge card API (/api/charge.php) | http-api | POST with invoice_id and card_token. Calls PayGate Charge, inserts a payments row and sets status='paid' without touching updated_at. Returns {ok:true, txn}. Problems:<br>- No auth check after session_start.<br>- No check that the invoice is still open.<br>- No idempotency.<br>- SOAP exceptions are not caught.<br>- DB errors are only logged. | [`public/api/charge.php:5`](app/public/api/charge.php#L5), [`public/api/charge.php:9`](app/public/api/charge.php#L9), [`public/api/charge.php:11`](app/public/api/charge.php#L11), [`public/api/charge.php:12`](app/public/api/charge.php#L12), [`public/api/charge.php:13`](app/public/api/charge.php#L13), [`public/api/charge.php:14`](app/public/api/charge.php#L14) |
| Staff UI script | web-ui | jQuery 1.7 delegate handler. Asks for the card token with prompt(), POSTs to /api/charge.php, and marks the row paid on any 2xx response without reading the body. | [`public/js/invoices.js:5`](app/public/js/invoices.js#L5), [`public/js/invoices.js:7`](app/public/js/invoices.js#L7), [`public/js/invoices.js:10`](app/public/js/invoices.js#L10) |
| Invoice status feed (/status.json) | http-api | GET ?since=. Returns a JSON array of {number, status, total_cents, updated_at} for rows with updated_at >= since. No app-level auth; it is protected only by the IP allowlist. Polled by the accounting ERP. | [`public/api/invoice_status.php:2`](app/public/api/invoice_status.php#L2), [`public/api/invoice_status.php:3`](app/public/api/invoice_status.php#L3), [`public/api/invoice_status.php:8`](app/public/api/invoice_status.php#L8), [`public/.htaccess:3`](app/public/.htaccess#L3) |
| Overdue reminder job | scheduled-job | Runs daily at 02:15 as www-data. For every open invoice with due_date before today, adds LATE_FEE_PERCENT of the current total and emails the customer with <number>.pdf attached. It is not idempotent, and because the selection never changes, the fee compounds every night. The return value of send_mail is ignored. | [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`cron/send_overdue_reminders.php:3`](app/cron/send_overdue_reminders.php#L3), [`cron/send_overdue_reminders.php:11`](app/cron/send_overdue_reminders.php#L11), [`cron/send_overdue_reminders.php:13`](app/cron/send_overdue_reminders.php#L13), [`includes/db.php:24`](app/includes/db.php#L24) |
| Weekly MySQL backup | scheduled-job | Sunday 03:00 mysqldump piped through gzip into one file that is overwritten each week. Errors are mailed to ops via MAILTO. | [`ops/crontab.txt:4`](app/ops/crontab.txt#L4), [`ops/crontab.txt:2`](app/ops/crontab.txt#L2) |
| DB access layer | library | ext/mysql connection forced to latin1. Builds SQL strings and logs errors without raising them. | [`includes/db.php:7`](app/includes/db.php#L7), [`includes/db.php:9`](app/includes/db.php#L9), [`includes/db.php:17`](app/includes/db.php#L17) |
| PaymentGateway | library | Native SoapClient with exceptions enabled. Charge sends {MerchantId, ApiKey, Reference 'INV-<id>', Amount, Token}. Refund exists but nothing calls it. | [`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8), [`includes/PaymentGateway.php:15`](app/includes/PaymentGateway.php#L15), [`includes/PaymentGateway.php:21`](app/includes/PaymentGateway.php#L21) |
| Mailer | library | PHPMailer over SMTP with auth. Sends from billing@acme.example. No Port or SMTPSecure is set. Requires vendor/, which is not in the repo. | [`includes/Mailer.php:3`](app/includes/Mailer.php#L3), [`includes/Mailer.php:8`](app/includes/Mailer.php#L8), [`includes/Mailer.php:12`](app/includes/Mailer.php#L12) |
| Configuration | config | Hard-coded config constants: DB_HOST, DB_NAME, DB_USER, DB_PASS, SMTP_HOST, SMTP_USER, SMTP_PASS, PAYGATE_WSDL, PAYGATE_MERCHANT_ID, PAYGATE_API_KEY, LATE_FEE_PERCENT, PDF_DIR. The secrets are stored as literals in a file committed to the repo. | [`includes/config.php:2`](app/includes/config.php#L2), [`includes/config.php:6`](app/includes/config.php#L6), [`includes/config.php:10`](app/includes/config.php#L10), [`includes/config.php:14`](app/includes/config.php#L14), [`includes/config.php:16`](app/includes/config.php#L16) |
| MySQL database 'invoicing' | database | Tables users, customers, invoices and payments, all MyISAM/latin1 with no foreign keys. A 2015 migration adds invoices.tax_cents and a tax_rates table, which no code uses. | [`sql/schema.sql:1`](app/sql/schema.sql#L1), [`sql/schema.sql:14`](app/sql/schema.sql#L14), [`sql/schema.sql:24`](app/sql/schema.sql#L24), [`sql/migrations/2015_add_tax.sql:1`](app/sql/migrations/2015_add_tax.sql#L1), [`sql/migrations/2015_add_tax.sql:3`](app/sql/migrations/2015_add_tax.sql#L3) |
| Invoice PDF directory | file-storage | /var/www/invoicing/storage/pdf, read by the reminder job. Nothing in the repo writes to it. | [`includes/config.php:17`](app/includes/config.php#L17), [`cron/send_overdue_reminders.php:12`](app/cron/send_overdue_reminders.php#L12) |

### Dependencies

| Dependency | Version | Action | Reason | Evidence |
|---|---|---|---|---|
| php | >=5.4 | replace | Code depends on ext/mysql, which only runs on PHP 5. Replaced by TypeScript on Workers. | [`composer.json:5`](app/composer.json#L5), [`includes/db.php:7`](app/includes/db.php#L7) |
| phpmailer/phpmailer | 5.2.9 | replace | Old PHPMailer version. Replace with Workers TCP connect() SMTP or an email API. | [`composer.json:6`](app/composer.json#L6), [`includes/Mailer.php:6`](app/includes/Mailer.php#L6) |
| econea/nusoap | 0.9.6 | remove | Declared but unused; the code uses ext/soap SoapClient. The SOAP envelope will be built by hand and sent with fetch. | [`composer.json:7`](app/composer.json#L7), [`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8) |
| tecnickcom/tcpdf | 6.2.12 | remove | Declared but never used. Nothing in the repo generates PDFs. | [`composer.json:8`](app/composer.json#L8) |
| jquery | 1.7.2 | replace | End-of-life, and the file is missing from the repo. Replace with plain fetch. | [`public/index.php:13`](app/public/index.php#L13), [`public/js/invoices.js:3`](app/public/js/invoices.js#L3) |
| ext/mysql | PHP 5 built-in | replace | Removed in PHP 7. Replace with pg through Hyperdrive using parameterised queries. | [`includes/db.php:7`](app/includes/db.php#L7) |
| ext/soap (SoapClient) | PHP built-in (not declared) | replace | Not available on Workers. Replace with a hand-built SOAP envelope sent with fetch. | [`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8) |

## Integrations and consumers

| Integration | Direction | Protocol | What it does | Migration action | Evidence |
|---|---|---|---|---|---|
| Staff browsers (office subnet) | inbound | HTTPS HTML + form POST + AJAX | Office staff on 10.20.0.0/24 use /index.php, /invoices, /login.php and /api/charge.php. Sessions are stored as files on app01. | Put Cloudflare Access (SSO) in front of the Worker and keep the old paths as aliases. Use the Access identity or a KV/signed-cookie session. Tell staff they will be logged out at cut-over. | [`ops/firewall-notes.txt:3`](app/ops/firewall-notes.txt#L3), [`public/index.php:3`](app/public/index.php#L3), [`public/js/invoices.js:7`](app/public/js/invoices.js#L7) |
| Accounting ERP status poll | inbound | HTTPS JSON (GET /status.json?since=) | The ERP at 10.20.0.15 polls every 15 minutes. It depends on:<br>- The exact path.<br>- A JSON array of {number, status, total_cents, updated_at}. ext/mysql returns every value as a string, and updated_at uses the MySQL 'YYYY-MM-DD HH:MM:SS' format.<br>- IP allowlisting instead of auth.<br>Rows with a NULL updated_at are never returned. Because charge.php does not set updated_at, the ERP never sees invoices become paid. This consumer appears only in a code comment and the firewall notes. | Keep the /status.json and /api/invoice_status.php paths with byte-compatible output: string types, the same timestamp format, and the same handling of an empty since. Protect them with an Access service token or a WAF rule on the ERP's egress IP. Write a contract test from captured production responses. Agree the ERP URL or DNS switch and the paid-status behaviour change with accounting. | [`ops/firewall-notes.txt:2`](app/ops/firewall-notes.txt#L2), [`public/api/invoice_status.php:2`](app/public/api/invoice_status.php#L2), [`public/api/invoice_status.php:8`](app/public/api/invoice_status.php#L8), [`public/.htaccess:3`](app/public/.htaccess#L3), [`sql/schema.sql:21`](app/sql/schema.sql#L21) |
| System cron (www-data on app01) | inbound | crontab / php CLI | Triggers the overdue reminder job daily at 02:15 server local time, and the weekly mysqldump. | Replace with a Cron Trigger that queues one message per invoice and is guarded by a late_fee_runs ledger. Replace the backup with Postgres PITR. Remove the crontab line before enabling the trigger. | [`ops/crontab.txt:1`](app/ops/crontab.txt#L1), [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4) |
| Unknown writer of invoices/customers/users | inbound | Unknown (probably direct SQL to db01) | No code in the repo inserts invoices, customers or users. Something outside the app creates them, most likely by writing straight to MySQL. | Identify it before P3. It must be pointed at Postgres, or at a new Worker API, at cut-over. This is a go/no-go gate. | [`sql/schema.sql:14`](app/sql/schema.sql#L14), [`includes/db.php:23`](app/includes/db.php#L23) |
| PayGate SOAP payment service | outbound | SOAP over HTTPS (443) | The Charge operation is called with MerchantId, ApiKey, Reference 'INV-<invoice id>', Amount and Token. Only TransactionId is read from the result. The firewall allows egress to soap.paygate.example:443. | Build the Charge envelope by hand from the WSDL and send it with fetch. Store the merchant ID and API key as Wrangler secrets. Keep invoice ids unchanged so the Reference values stay the same. Find out whether PayGate allowlists source IPs, since Workers egress IPs are not fixed, and whether it de-duplicates on Reference. | [`includes/config.php:12`](app/includes/config.php#L12), [`includes/PaymentGateway.php:12`](app/includes/PaymentGateway.php#L12), [`ops/firewall-notes.txt:6`](app/ops/firewall-notes.txt#L6) |
| SMTP mail relay | outbound | SMTP (firewall allows 587) | The reminder job sends mail from billing@acme.example to customers.email with the invoice PDF attached. The code does not set a port, although the firewall only allows 587. | Use Workers TCP connect() with STARTTLS on 587, or an email API. Confirm the live port. Keep the sender address and confirm SPF/DKIM for the new sending path. | [`includes/Mailer.php:8`](app/includes/Mailer.php#L8), [`includes/Mailer.php:12`](app/includes/Mailer.php#L12), [`includes/config.php:8`](app/includes/config.php#L8), [`ops/firewall-notes.txt:7`](app/ops/firewall-notes.txt#L7) |
| MySQL db01 | outbound | MySQL protocol | The app's only database, also read by the backup cron. | Migrate to Postgres through Hyperdrive. During the parallel run, export from a snapshot or replica to avoid locking production. | [`includes/config.php:3`](app/includes/config.php#L3), [`includes/db.php:7`](app/includes/db.php#L7), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4) |
| Local PDF storage | outbound | Local filesystem | The reminder job attaches PDF_DIR/<number>.pdf. The process that writes these files is unknown. | Copy the files to R2, keyed by invoice id with the number kept as metadata. Whatever generates the PDFs must write to R2 after cut-over. | [`includes/config.php:17`](app/includes/config.php#L17), [`cron/send_overdue_reminders.php:12`](app/cron/send_overdue_reminders.php#L12) |
| Ops error mail (cron MAILTO) | outbound | SMTP (cron MAILTO) | Cron output that is not redirected, which here is the mysqldump stderr, is mailed to ops@acme.example. | Replace with Workers Logs/Tail alerts for failed Cron Trigger and Queue runs before P3. | [`ops/crontab.txt:2`](app/ops/crontab.txt#L2) |

## Data migration

1. **Profile the source database.** Work from a snapshot or replica, not live MyISAM. Steps:
   - Run SHOW CREATE TABLE to confirm the 2015 migration (tax_cents, tax_rates) was applied.
   - Record row counts per table.
   - Find zero or invalid dates, rows with NULL updated_at, and duplicate invoices.number values.
   - Find duplicate payments rows per invoice_id, which can exist because charge.php has no guard.
   - Find orphan invoices and payments (there are no foreign keys).
   - Find non-ASCII bytes, and UTF-8 sequences stored in latin1 columns (double encoding).
   - Measure the PDF file count and total size.

   - Tables: `users`, `customers`, `invoices`, `payments`, `tax_rates`
   - Verify: A signed-off profile report with counts for each anomaly class, and a decision recorded for each one: keep, fix or quarantine.
   - Evidence: [`sql/schema.sql:1`](app/sql/schema.sql#L1), [`sql/schema.sql:17`](app/sql/schema.sql#L17), [`sql/schema.sql:21`](app/sql/schema.sql#L21), [`sql/migrations/2015_add_tax.sql:1`](app/sql/migrations/2015_add_tax.sql#L1), [`public/api/charge.php:12`](app/public/api/charge.php#L12)

2. **Create the Postgres schema.** Use identity columns that keep the source ids, because the PayGate Reference uses the invoice id. Other changes:
   - invoices.status as text with CHECK ('open','paid','void').
   - DATETIME becomes timestamp, interpreted in the documented server time zone.
   - payments gets new nullable columns status and idempotency_key, with a unique index on idempotency_key only. Existing duplicate rows stay as they are.
   - New table late_fee_runs(invoice_id, business_date) with a unique constraint.
   - Foreign keys are added after orphans are resolved.

   - Tables: `users`, `customers`, `invoices`, `payments`, `tax_rates`, `late_fee_runs`
   - Verify: Run the schema diff against the mapping document. Apply the migration from scratch in CI.
   - Evidence: [`sql/schema.sql:19`](app/sql/schema.sql#L19), [`sql/schema.sql:24`](app/sql/schema.sql#L24), [`includes/PaymentGateway.php:15`](app/includes/PaymentGateway.php#L15)

3. **Rehearsal bulk load.** Export from a snapshot or replica. Running mysqldump --lock-tables on live MyISAM would block charges and the cron, so if a live dump is unavoidable, run it outside business hours and away from 02:15 Mon–Sun and 03:00 Sunday. Convert the text as Windows-1252 to UTF-8 and fix any double-encoded rows found in profiling. Load the data, then reset the sequences to MAX(id)+1. Repeat at least twice and record the duration to size the cut-over window.

   - Tables: `users`, `customers`, `invoices`, `payments`, `tax_rates`
   - Verify: For each table, compare:
     - Row counts.
     - SUM(total_cents), SUM(tax_cents) and SUM(amount_cents).
     - An MD5 of the ordered id list.
     - A per-row hash of normalised columns.
     - A random 1% sample compared field by field.
     Zero differences are required.
   - Evidence: [`includes/db.php:9`](app/includes/db.php#L9), [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4)

4. **Copy PDFs to R2.** Copy every file in PDF_DIR to R2. Use a key based on the invoice id, looked up by number, with the original file name and number kept as metadata. List PDFs that match no invoice, or more than one, for review.

   - Verify: The file count matches, the SHA-256 of every object matches the source, and the list of unmapped or ambiguous files has been reviewed.
   - Evidence: [`includes/config.php:17`](app/includes/config.php#L17), [`cron/send_overdue_reminders.php:12`](app/cron/send_overdue_reminders.php#L12)

5. **Carry over password hashes.** Copy password_md5 unchanged. The new login checks the MD5 hash, then immediately rehashes with argon2id or bcrypt and clears the MD5 value. If Cloudflare Access SSO replaces passwords, keep the users table only to map staff identities.

   - Tables: `users`
   - Verify: Test accounts can log in on the new system. Count users still holding an MD5 hash over time.
   - Evidence: [`public/login.php:8`](app/public/login.php#L8), [`sql/schema.sql:5`](app/sql/schema.sql#L5)

6. **Final load at cut-over and seeding the fee ledger.** During the P3 write freeze:
   - The old charge endpoint returns 503.
   - Crontab line 3 is removed.
   - The unknown writer is paused.

   Then run a full reload (MyISAM has no change tracking). Seed late_fee_runs for every currently overdue open invoice with the business date of the last old run, so the new trigger cannot apply a second fee that day.

   - Tables: `users`, `customers`, `invoices`, `payments`, `tax_rates`, `late_fee_runs`
   - Verify: Repeat every check from step 3. Diff /status.json from old and new for several since values: epoch, empty, and the last 24 hours. Confirm the seeded late_fee_runs count equals the count of overdue open invoices.
   - Evidence: [`includes/db.php:24`](app/includes/db.php#L24), [`public/api/invoice_status.php:8`](app/public/api/invoice_status.php#L8), [`ops/crontab.txt:3`](app/ops/crontab.txt#L3)

7. **Final archive of the old system.** After P4 ends, take a final mysqldump plus a tarball of the PDFs and store them in cold storage with checksums and a retention period agreed with finance.

   - Tables: `users`, `customers`, `invoices`, `payments`, `tax_rates`
   - Verify: Restore the archive into a scratch MySQL and confirm the row counts and sums match the step 6 numbers. Recheck the archive checksums.
   - Evidence: [`ops/crontab.txt:4`](app/ops/crontab.txt#L4), [`includes/config.php:17`](app/includes/config.php#L17)


## Cut-over phases

### P0: Preparation and secrets

**Goal:** Provision the target platform, move secrets out of source, answer the gating questions, and put backups and alerting in place.

Steps:

1. Provision Postgres with PITR enabled and run a restore test. Provision Hyperdrive, R2, Queues, Cloudflare Access and Workers Logs alerting.
2. Create new credentials alongside the old ones: a new MySQL user for the export, a second PayGate key if PayGate supports two at once, and new SMTP credentials. Store them as Wrangler secrets. Leave the app01 credentials untouched for now.
3. Treat DB_PASS, SMTP_PASS and PAYGATE_API_KEY as exposed because they are in the repo. Plan their rotation and add secret scanning.
4. Capture production samples of /status.json responses and the PHP error log. Before the parallel run, add a fee log to the PHP job: log invoice_id, the fee and send_mail's return value.
5. Resolve the gating open questions: who the unknown writer is, how the ERP is reached and authenticated, PayGate source-IP allowlisting, SMTP port, server time zone, and whether the compounding fee is intended.

Exit criteria:

- The PITR restore test passed.
- The unknown invoice/customer/user writer is identified, with a plan to repoint it.
- The ERP owner has agreed the access method and URL.
- Alerting fires on a test failure.

**Rollback:** Production behaviour is unchanged except for the added logging in the PHP job. Revert that change from version control. Revoke any new credentials; the old ones stay valid throughout P0.

Evidence: [`includes/config.php:2`](app/includes/config.php#L2), [`includes/config.php:6`](app/includes/config.php#L6), [`ops/crontab.txt:2`](app/ops/crontab.txt#L2), [`cron/send_overdue_reminders.php:13`](app/cron/send_overdue_reminders.php#L13)

### P1: Build and rehearse

**Goal:** Build the Worker with route and contract parity plus safety fixes, and rehearse the data load.

Steps:

1. Routes: /, /index.php, /invoices, /login.php, /api/charge.php, /status.json and /api/invoice_status.php. Escape all output.
2. Charge flow:
   - Require an authenticated staff user.
   - Require status='open'.
   - Insert a pending payment row with an idempotency key before calling PayGate.
   - Set updated_at when marking the invoice paid.
   - Return a non-2xx response on any failure (invoices.js treats every 2xx as paid).
   - Add a reconciliation job that checks PayGate by Reference INV-<id>.
3. Reminder job: a Cron Trigger at the UTC equivalent of 02:15 in the business time zone puts one Queue message per invoice. The consumer inserts into late_fee_runs (unique on invoice_id and business_date) in the same transaction as the fee update, and records the email send separately. An env flag REMINDER_MODE=off|dryrun|live defaults to off.
4. Contract tests for /status.json: string field types, timestamp format, NULL updated_at, and empty or malformed since.
5. Write and rehearse the reverse-sync script (Postgres to MySQL) for invoices and payments changed after cut-over.
6. Run data migration steps 1–5 against a snapshot at least twice.

Exit criteria:

- Contract tests pass against the captured production responses.
- The rehearsal loads verify with zero differences.
- The reverse sync has been rehearsed into a scratch MySQL.
- A security review of the charge flow is done.

**Rollback:** Nothing in production depends on the new environment. Discard or redeploy it.

Evidence: [`public/api/charge.php:13`](app/public/api/charge.php#L13), [`public/js/invoices.js:10`](app/public/js/invoices.js#L10), [`public/api/invoice_status.php:8`](app/public/api/invoice_status.php#L8), [`includes/db.php:24`](app/includes/db.php#L24)

### P2: Parallel run (shadow, read-only)

**Goal:** Prove the new system matches the old one while MySQL and the PHP app remain authoritative.

Steps:

1. Refresh Postgres from a MySQL snapshot or replica each day after the 02:15 job finishes.
2. Run the new Worker behind Access for a pilot group in read-only mode, with charge disabled.
3. Run REMINDER_MODE=dryrun: compute the fee list without any UPDATE, and send mail only to an internal test mailbox.
4. Each day, compare the dry-run fee list with the new PHP fee log and with the before/after difference in invoices.total_cents around 02:15.
5. Each day, diff /status.json responses from old and new for the same since values.

Exit criteria:

- At least 10 consecutive business days with zero unexplained differences in the fee list and the status feed.
- Pilot staff sign-off.
- The dry-run job completes within Worker and Queue limits at the observed volume.

**Rollback:** Disable the Worker route or the Access application. The old system was never changed.

Evidence: [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`cron/send_overdue_reminders.php:11`](app/cron/send_overdue_reminders.php#L11), [`public/api/invoice_status.php:13`](app/public/api/invoice_status.php#L13)

### P3: Cut-over (traffic switch)

**Goal:** Make the Worker and Postgres authoritative without a double fee or a lost payment.

Steps:

1. Precondition: the unknown writer is ready to be repointed.
2. Start the window after the 02:15 run has finished and logged. Remove crontab line 3 on app01 and confirm with crontab -l.
3. Make the old charge.php return 503 and pause the unknown writer.
4. Run data migration step 6, including seeding the late_fee_runs ledger, and verify it.
5. Repoint the unknown writer. Switch DNS or routes for the staff hostname and the ERP path. Confirm the ERP's first successful poll in the Worker logs.
6. Set REMINDER_MODE=live only after confirming crontab line 3 is gone. The ledger blocks any second fee on the same business day.

Exit criteria:

- Verification checks pass.
- The ERP polls successfully for 24 hours.
- The first live reminder run applies fees only to invoices that have no ledger row for that business date.
- No charge errors in reconciliation.

**Rollback:**

1. Set REMINDER_MODE=off.
2. Run the reverse sync for invoices and payments changed in Postgres, together with any invoices created by the repointed writer.
3. Point DNS and routes back to app01 and remove the 503 from charge.php.
4. Point the writer back at MySQL.
5. Restore crontab line 3 only from the next business day if the new job already ran that day.

Evidence: [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`public/api/charge.php:1`](app/public/api/charge.php#L1), [`public/.htaccess:3`](app/public/.htaccess#L3), [`ops/firewall-notes.txt:2`](app/ops/firewall-notes.txt#L2)

### P4: Old system read-only (2–4 weeks)

**Goal:** Keep the old system available for reference and rollback while preventing any writes to it.

Steps:

1. Set read_only on db01 and revoke write grants from invoicing_app. Keep the reverse-sync user's grants documented, but disabled.
2. Leave app01 serving reads only on an internal hostname, or stop Apache. Keep the crontab empty.
3. Watch the app01 access logs for any remaining callers, especially 10.20.0.15.

Exit criteria:

- Zero inbound requests to app01 for 2 weeks.
- Finance has signed off on reconciliation between PayGate and the Postgres payments table.

**Rollback:** Lift read_only, restore the invoicing_app and reverse-sync grants, then follow the P3 rollback (reminder off, reverse sync, DNS back, crontab from the next business day).

Evidence: [`includes/config.php:5`](app/includes/config.php#L5), [`ops/firewall-notes.txt:1`](app/ops/firewall-notes.txt#L1)

### P5: Decommission

**Goal:** Archive the old data, rotate credentials, remove network entries and shut down the hosts.

Steps:

1. Run the decommission checklist in order.

Exit criteria:

- Every checklist item is complete, with evidence attached to the change ticket.

**Rollback:** Up to the host shutdown, restore from the final archive (data step 7). After the shutdown, rebuilding from the archive is the only option, so do not shut down until the P4 exit criteria are met.

Evidence: [`ops/crontab.txt:1`](app/ops/crontab.txt#L1), [`ops/firewall-notes.txt:1`](app/ops/firewall-notes.txt#L1)

## Decommission checklist

- [ ] Confirm 2 weeks with zero inbound traffic in the app01 access logs, including from the ERP at 10.20.0.15 and the office subnet. ([`ops/firewall-notes.txt:2`](app/ops/firewall-notes.txt#L2), [`ops/firewall-notes.txt:3`](app/ops/firewall-notes.txt#L3))
- [ ] Remove both crontab entries for www-data on app01 (reminder and mysqldump) and confirm with crontab -l. ([`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4))
- [ ] Take the final mysqldump of 'invoicing' and a tarball of /var/www/invoicing/storage/pdf. Record checksums, do a restore test, and store them in cold storage with the agreed retention. ([`includes/config.php:4`](app/includes/config.php#L4), [`includes/config.php:17`](app/includes/config.php#L17))
- [ ] Archive /var/log/invoicing/overdue.log and the old /backups/invoicing-weekly.sql.gz, then delete them from the hosts. ([`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4))
- [ ] Drop the invoicing_app MySQL user and any .my.cnf used by the backup job. ([`includes/config.php:5`](app/includes/config.php#L5), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4))
- [ ] Rotate and revoke the old credentials that were in source: DB_PASS (includes/config.php:6), SMTP_PASS (includes/config.php:10) and PAYGATE_API_KEY (includes/config.php:14). Remove config.php from the repo, or replace it with a template. ([`includes/config.php:6`](app/includes/config.php#L6), [`includes/config.php:10`](app/includes/config.php#L10), [`includes/config.php:14`](app/includes/config.php#L14))
- [ ] Remove the app01 inbound allowlist rules (10.20.0.15, 10.20.0.0/24) and the egress rules to soap.paygate.example:443 and smtp.mail.example:587. Ask PayGate to remove app01's IP from any allowlist they hold. ([`ops/firewall-notes.txt:2`](app/ops/firewall-notes.txt#L2), [`ops/firewall-notes.txt:6`](app/ops/firewall-notes.txt#L6), [`ops/firewall-notes.txt:7`](app/ops/firewall-notes.txt#L7))
- [ ] Remove the DNS records for app01 and the old invoicing hostname. If db01 is not shared, remove db01.internal.example as well. ([`includes/config.php:3`](app/includes/config.php#L3))
- [ ] Shut down and deprovision app01 (/var/www/invoicing) and, if it is not shared with other apps, db01. ([`README.txt:8`](app/README.txt#L8), [`ops/crontab.txt:1`](app/ops/crontab.txt#L1))

## Risks

| Severity | Risk | Description | Mitigation | Evidence |
|---|---|---|---|---|
| critical | Late-fee job is not idempotent and compounds | The job selects every open invoice with due_date before today and adds a percentage of the current total. Running it does not change the selection, so the fee compounds nightly and any double run doubles fees. If the old cron and the new trigger run on the same business day, for example on the cut-over day or during a rollback, customers are overcharged and emailed twice. | - Remove the old crontab line before enabling the new trigger, and only enable the trigger behind REMINDER_MODE.<br>- Keep a late_fee_runs ledger, unique on invoice_id and business_date, seeded with the last old run date at cut-over.<br>- Use the dryrun mode during the parallel run.<br>- On rollback, re-enable the crontab only from the next business day. | [`cron/send_overdue_reminders.php:3`](app/cron/send_overdue_reminders.php#L3), [`cron/send_overdue_reminders.php:11`](app/cron/send_overdue_reminders.php#L11), [`includes/db.php:24`](app/includes/db.php#L24), [`ops/crontab.txt:3`](app/ops/crontab.txt#L3) |
| critical | Unknown external writer of invoices, customers and users | Nothing in the repo creates invoices, customers or users. If the system that does this keeps writing to MySQL after cut-over, the new data never reaches Postgres. Once MySQL is read-only (P4), those writes fail. | Identifying the writer and repointing it is a go/no-go gate for P3. Monitor for new rows in MySQL after cut-over. | [`sql/schema.sql:14`](app/sql/schema.sql#L14), [`includes/db.php:23`](app/includes/db.php#L23) |
| high | Charge can bill a card with no local record, or bill twice | The charge endpoint:<br>- Has no auth check.<br>- Does not check that the invoice is open.<br>- Has no idempotency key.<br>- Has no transaction (MyISAM).<br>- Does not catch SOAP exceptions.<br>- Only logs DB errors.<br>- Always returns ok:true.<br>The UI marks the invoice paid on any 2xx. A timeout or a failed INSERT leaves a charged card with no payment row, and staff then retry. | New flow: an authenticated user, a status='open' check, a pending payment row with an idempotency key written before the gateway call, a non-2xx response on failure, and a reconciliation job that checks PayGate by Reference. Before cut-over, reconcile historical payments against PayGate. | [`public/api/charge.php:5`](app/public/api/charge.php#L5), [`public/api/charge.php:12`](app/public/api/charge.php#L12), [`public/api/charge.php:14`](app/public/api/charge.php#L14), [`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8), [`includes/db.php:17`](app/includes/db.php#L17), [`public/js/invoices.js:10`](app/public/js/invoices.js#L10) |
| high | ERP feed contract and access control | The ERP depends on the exact path, string-typed JSON fields and the MySQL timestamp format. It is protected only by an IP allowlist, while a Worker is reachable from the internet. Rows with a NULL updated_at never appear in the feed, and a paid status never appears either, because charge.php does not set updated_at. Fixing that changes what the ERP receives. | - Write a contract test from captured responses.<br>- Add Access service-token or WAF IP protection.<br>- Agree with accounting before shipping the updated_at fix and any backfill.<br>- Cover empty or malformed since values. | [`public/api/invoice_status.php:3`](app/public/api/invoice_status.php#L3), [`public/api/invoice_status.php:8`](app/public/api/invoice_status.php#L8), [`public/api/charge.php:13`](app/public/api/charge.php#L13), [`sql/schema.sql:21`](app/sql/schema.sql#L21) |
| high | Credentials exposed in the repository | DB_PASS, SMTP_PASS and PAYGATE_API_KEY are literals in a committed file. | Treat them as compromised. Rotate them during P0–P5, use Wrangler secrets, and add secret scanning. Consider rewriting git history. | [`includes/config.php:6`](app/includes/config.php#L6), [`includes/config.php:10`](app/includes/config.php#L10), [`includes/config.php:14`](app/includes/config.php#L14) |
| medium | Character set conversion | MySQL 'latin1' is really cp1252, and some UTF-8 may be stored double-encoded. PHP json_encode fails on non-UTF-8 strings, so the current feed may already break on some rows. | Convert as Windows-1252, detect double encoding during profiling, and check the PHP error log for json_encode failures. | [`includes/db.php:9`](app/includes/db.php#L9), [`public/api/invoice_status.php:13`](app/public/api/invoice_status.php#L13) |
| medium | Time zone shift for the job and dates | The cron runs at 02:15 server local time, and CURDATE()/NOW() use the server time zone. Cron Triggers run in UTC, so the overdue cutoff and the business_date in the ledger can move. | Confirm the server time zone. Compute business_date explicitly in that zone, and convert DATETIME values using it. | [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`includes/db.php:24`](app/includes/db.php#L24) |
| medium | Worker limits on the reminder job | A single invocation that sends SMTP mail with PDF attachments for every overdue invoice can exceed CPU and subrequest limits. Today a failed send is ignored and the fee is still applied. | Put one Queue message per invoice. Record the fee and the email send separately so retries are safe. Load-test during P2. | [`cron/send_overdue_reminders.php:11`](app/cron/send_overdue_reminders.php#L11), [`cron/send_overdue_reminders.php:13`](app/cron/send_overdue_reminders.php#L13) |
| medium | Outbound network differences (SMTP port, PayGate allowlist) | The code sets no SMTP port (PHPMailer's default is 25), but the firewall only allows 587. PayGate may allowlist the source IP of app01, while Workers egress IPs are not fixed. | Confirm the live port and PayGate's IP policy in P0. Use 587 with STARTTLS, or an email API. If PayGate requires fixed IPs, plan dedicated egress. | [`includes/Mailer.php:8`](app/includes/Mailer.php#L8), [`ops/firewall-notes.txt:6`](app/ops/firewall-notes.txt#L6), [`ops/firewall-notes.txt:7`](app/ops/firewall-notes.txt#L7) |
| medium | PDFs not generated by this app | Nothing writes PDF_DIR and TCPDF is unused. If a file is missing, the email is sent without an attachment. Invoice numbers are not unique, so naming files by number can be ambiguous. | Identify the PDF generator and repoint it to R2. Key R2 objects by invoice id. | [`includes/config.php:17`](app/includes/config.php#L17), [`composer.json:8`](app/composer.json#L8), [`sql/schema.sql:17`](app/sql/schema.sql#L17) |
| medium | Rehearsal export locks production | mysqldump with table locks on MyISAM blocks the charge endpoint and the fee job while it runs. | Export from a snapshot or replica. Otherwise run outside business hours and away from 02:15 and the Sunday 03:00 run. | [`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4) |
| medium | Sessions and weak auth | Sessions are files on app01 that cannot move to Workers, so staff are logged out at cut-over. Passwords are unsalted MD5, the session id is not regenerated at login, and the invoice list has XSS. | Use Access SSO or a KV/signed-cookie session, rehash passwords on login, escape output, and tell staff about the forced re-login. | [`public/login.php:8`](app/public/login.php#L8), [`public/login.php:9`](app/public/login.php#L9), [`public/index.php:20`](app/public/index.php#L20) |
| medium | Loss of backups and alerting at cut-over | The only backup is a weekly dump that overwrites a single file, and cron errors go to the ops mailbox via MAILTO. Neither carries over to the new platform. | Enable Postgres PITR and run a restore test in P0. Set up Workers Logs alerts before P3. | [`ops/crontab.txt:2`](app/ops/crontab.txt#L2), [`ops/crontab.txt:4`](app/ops/crontab.txt#L4) |
| low | Workers is not a full Node 22 runtime | The target says Node 22, but Workers offers only a nodejs_compat subset. There is no SoapClient, no local filesystem, and TCP is limited to connect(). | Avoid Node-only libraries, hand-build the SOAP envelope, use R2 for files, and test in workerd/Miniflare. | [`includes/PaymentGateway.php:8`](app/includes/PaymentGateway.php#L8), [`includes/config.php:17`](app/includes/config.php#L17) |

## Open questions

1. **Which system or person creates invoices, customers and users, and how? (No code in this repo does.)** It must be pointed at Postgres at cut-over, or new data is lost. This is a go/no-go gate. Ask: Finance/accounting ops and the DBA for db01. ([`sql/schema.sql:14`](app/sql/schema.sql#L14))
2. **Is the nightly compounding late fee intended, or should the fee be applied once per invoice or once per period?** It determines whether the new job copies the current behaviour or fixes it, and changes customer balances. Ask: Finance / billing owner. ([`cron/send_overdue_reminders.php:10`](app/cron/send_overdue_reminders.php#L10), [`includes/db.php:24`](app/includes/db.php#L24))
3. **How does the ERP reach the app (hostname or IP), can it send an auth token or header, which egress IP does it use toward the internet, and what since values does it send?** This decides the access-control method for the Worker, whether a DNS switch is enough, and which contract tests are needed. Ask: Accounting/ERP team. ([`ops/firewall-notes.txt:2`](app/ops/firewall-notes.txt#L2), [`public/api/invoice_status.php:7`](app/public/api/invoice_status.php#L7))
4. **Will the ERP accept invoices starting to appear with status 'paid' once updated_at is set on charge? Should historical paid invoices be backfilled?** Fixing the bug changes what the ERP receives and may duplicate or alter its records. Ask: Accounting/ERP team. ([`public/api/charge.php:13`](app/public/api/charge.php#L13))
5. **Are there other consumers of /status.json or the app (scripts or reports from the office subnet, bookmarks to /invoices)?** Every machine on the /24 can reach the feed today, and those callers would break silently. Ask: Network/security team (access logs). ([`ops/firewall-notes.txt:3`](app/ops/firewall-notes.txt#L3), [`public/.htaccess:2`](app/public/.htaccess#L2))
6. **Does PayGate allowlist source IPs, support two active API keys, and de-duplicate charges on Reference?** Workers egress IPs differ from app01's. Key rotation without downtime and double-charge protection both depend on the answers. Ask: PayGate account manager. ([`includes/PaymentGateway.php:15`](app/includes/PaymentGateway.php#L15), [`ops/firewall-notes.txt:6`](app/ops/firewall-notes.txt#L6))
7. **Which SMTP port and TLS settings actually work in production, and are SPF/DKIM set up for billing@acme.example?** The code sets no port, but the firewall allows only 587, and mail deliverability from the new path depends on DNS auth records. Ask: Mail/infra team. ([`includes/Mailer.php:8`](app/includes/Mailer.php#L8), [`ops/firewall-notes.txt:7`](app/ops/firewall-notes.txt#L7))
8. **What generates the invoice PDFs in storage/pdf?** That generator must write to R2 after cut-over, or reminders go out without attachments. Ask: App owner / ops. ([`includes/config.php:17`](app/includes/config.php#L17), [`composer.json:8`](app/composer.json#L8))
9. **What are the data volumes (row counts, PDF count and size, number of overdue invoices per night) and app01's time zone?** Volumes size the cut-over window and the Worker/Queue design. The time zone affects the fee date and timestamp conversion. Ask: DBA / ops. ([`ops/crontab.txt:3`](app/ops/crontab.txt#L3), [`sql/schema.sql:21`](app/sql/schema.sql#L21))
10. **Is db01 shared with other applications? Is the 2015 tax migration applied, and is tax_cents/tax_rates used by anything outside this repo?** This decides whether db01 can be shut down and whether the tax data must keep its meaning. Ask: DBA. ([`sql/migrations/2015_add_tax.sql:1`](app/sql/migrations/2015_add_tax.sql#L1), [`includes/config.php:3`](app/includes/config.php#L3))
11. **What retention period does finance require for the archived invoice and payment data?** It sets how long the final archive is kept after decommission. Ask: Finance / compliance. ([`ops/crontab.txt:4`](app/ops/crontab.txt#L4))

## Reviewer findings

Raised by the risk-reviewer subagent against the draft plan, and how the plan changed:

- The P2 comparison relied on overdue.log, but the cron script prints nothing, so the log has no fee data. **Resolution:** P0 now adds fee logging to the PHP job. P2 compares the dry-run fees with that log and with before/after snapshots of total_cents around 02:15.
- The P0 rollback said 'nothing changed in prod', but rotating credentials changes app01. **Resolution:** P0 now creates new credentials alongside the old ones without touching app01. Rotating the old ones moves to decommission. The P0 rollback reverts the logging change and revokes the new credentials. A question about PayGate dual keys was added.
- A unique constraint on payments needs a status column, and existing duplicate payments would break the load. **Resolution:** Data step 2 adds nullable status and idempotency_key columns, with a unique index only on idempotency_key. Data step 1 profiles duplicate payments.
- Invoice numbers are not unique, so keying PDFs by number is unsafe. **Resolution:** R2 keys now use the invoice id, with the number kept as metadata. Ambiguous or unmapped files are reported. Duplicate numbers are profiled in step 1.
- The fee ledger did not cover the cut-over day, and the cron and Cron Trigger time zones differ. **Resolution:** Data step 6 seeds late_fee_runs with the last old run date. business_date is defined in the server time zone. A time-zone risk and an open question were added.
- The P3 rollback could re-enable the crontab on the same day the new job ran. **Resolution:** The P3 rollback order is now: reminder off, reverse sync, DNS back, crontab only from the next business day.
- The P4 read-only lock blocks the reverse-sync rollback. **Resolution:** The P4 rollback now lifts read_only and restores grants first. The reverse sync is rehearsed in P1.
- The unknown writer breaks cut-over and rollback and was rated only medium. **Resolution:** Raised to critical, made a go/no-go gate in P0/P3, added as an inbound integration, and added to the P3 rollback steps.
- Charge can bill a card with no local record (uncaught SOAP exceptions, DB errors only logged, ok:true always returned). **Resolution:** Added as a high risk. P1 now has a pending row written before the gateway call, non-2xx on failure, reconciliation by Reference, and unchanged invoice ids.
- PHP sessions are stored as files on app01. **Resolution:** Covered in the staff integration action and the sessions risk. Staff are told to expect a forced re-login.
- 'latin1' is really cp1252, data may be double-encoded, and json_encode fails on non-UTF-8. **Resolution:** Steps 1 and 3 now convert as Windows-1252 and detect double encoding. A character-set risk was added.
- NULL updated_at rows and empty since values in the feed were not handled. **Resolution:** Added to the P1 contract tests, step 6 verification, the ERP risk, and an open question on backfill.
- The reminder job may hit Worker CPU and subrequest limits. **Resolution:** Redesigned as a Cron Trigger feeding a Queue, one message per invoice, with the fee and email recorded separately. A load check was added to the P2 exit criteria.
- Alerting through cron MAILTO is lost. **Resolution:** Added as an integration. Workers Logs alerting is a P0 exit criterion.
- No Postgres backups were set up before mysqldump is decommissioned. **Resolution:** PITR plus a restore test is now in P0, with a risk for backup and alerting loss.
- Credentials are committed to the repo. The reviewer read the config.php:2 comment as claiming the file was never committed. **Resolution:** Partially accepted. The comment at config.php:2 says the values are 'never committed to a secrets store', not that the file is absent from git. Either way the file is in the repo, so the credentials are treated as exposed: high risk, secret scanning, and rotation in the decommission checklist.
- Rehearsal mysqldump --lock-tables blocks production. **Resolution:** Step 3 now exports from a snapshot or replica, or otherwise runs outside business hours and away from 02:15 and the Sunday 03:00 run. A matching risk was added.
