<?php
require_once __DIR__ . '/../includes/db.php';
session_start();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email = mysql_real_escape_string($_POST['email']);
    $res = db_query("SELECT id, password_md5 FROM users WHERE email = '$email'");
    $user = mysql_fetch_assoc($res);
    if ($user && $user['password_md5'] === md5($_POST['password'])) {
        $_SESSION['user_id'] = $user['id'];
        header('Location: /index.php');
        exit;
    }
}
?>
<form method="post"><input name="email"><input name="password" type="password"><button>Log in</button></form>
