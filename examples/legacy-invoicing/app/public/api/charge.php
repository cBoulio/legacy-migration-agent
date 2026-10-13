<?php
// Called by public/js/invoices.js when staff click "Charge card".
require_once __DIR__ . '/../../includes/db.php';
require_once __DIR__ . '/../../includes/PaymentGateway.php';
session_start();
header('Content-Type: application/json');

$id = intval($_POST['invoice_id']);
$inv = mysql_fetch_assoc(db_query("SELECT * FROM invoices WHERE id = $id"));
$gw = new PaymentGateway();
$result = $gw->charge($id, $inv['total_cents'], $_POST['card_token']);
db_query("INSERT INTO payments (invoice_id, amount_cents, gateway_txn_id, created_at) VALUES ($id, {$inv['total_cents']}, '{$result->TransactionId}', NOW())");
db_query("UPDATE invoices SET status = 'paid' WHERE id = $id");
echo json_encode(array('ok' => true, 'txn' => $result->TransactionId));
