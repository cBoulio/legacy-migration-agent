<?php
require_once __DIR__ . '/config.php';

function db() {
    static $conn = null;
    if ($conn === null) {
        $conn = mysql_connect(DB_HOST, DB_USER, DB_PASS);
        mysql_select_db(DB_NAME, $conn);
        mysql_set_charset('latin1', $conn);
    }
    return $conn;
}

function db_query($sql) {
    $res = mysql_query($sql, db());
    if (!$res) {
        error_log('SQL error: ' . mysql_error());
    }
    return $res;
}

function find_overdue_invoices() {
    return db_query("SELECT i.*, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id
                     WHERE i.status = 'open' AND i.due_date < CURDATE()");
}
