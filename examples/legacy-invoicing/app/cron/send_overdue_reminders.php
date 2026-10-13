<?php
// Runs nightly from cron (ops/crontab.txt). Emails customers whose invoices are overdue
// and adds a late fee. Not idempotent: running it twice charges the late fee twice.
if (php_sapi_name() !== 'cli') { exit(1); }
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/Mailer.php';

$res = find_overdue_invoices();
while ($inv = mysql_fetch_assoc($res)) {
    $fee = round($inv['total_cents'] * LATE_FEE_PERCENT / 100);
    db_query("UPDATE invoices SET total_cents = total_cents + $fee, updated_at = NOW() WHERE id = {$inv['id']}");
    $pdf = PDF_DIR . '/' . $inv['number'] . '.pdf';
    send_mail($inv['email'], 'Overdue invoice ' . $inv['number'], '<p>Your invoice is overdue. A late fee was added.</p>', $pdf);
}
