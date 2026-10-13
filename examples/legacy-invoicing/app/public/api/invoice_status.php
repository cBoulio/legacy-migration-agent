<?php
// Read-only status feed. The accounting team's ERP polls this every 15 minutes
// (see ops/firewall-notes.txt). No session auth: protected only by IP allowlist.
require_once __DIR__ . '/../../includes/db.php';
header('Content-Type: application/json');

$since = mysql_real_escape_string($_GET['since']);
$res = db_query("SELECT number, status, total_cents, updated_at FROM invoices WHERE updated_at >= '$since'");
$out = array();
while ($row = mysql_fetch_assoc($res)) {
    $out[] = $row;
}
echo json_encode($out);
