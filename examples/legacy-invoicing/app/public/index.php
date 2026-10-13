<?php
require_once __DIR__ . '/../includes/db.php';
session_start();
if (empty($_SESSION['user_id'])) {
    header('Location: /login.php');
    exit;
}
$invoices = db_query("SELECT id, number, total_cents, status, due_date FROM invoices ORDER BY due_date DESC LIMIT 100");
?>
<html>
<head>
  <title>Invoices</title>
  <script src="/js/jquery-1.7.2.min.js"></script>
  <script src="/js/invoices.js"></script>
</head>
<body>
  <table id="invoices">
  <?php while ($row = mysql_fetch_assoc($invoices)): ?>
    <tr data-id="<?php echo $row['id']; ?>">
      <td><?php echo $row['number']; ?></td>
      <td><?php echo number_format($row['total_cents'] / 100, 2); ?></td>
      <td><?php echo $row['status']; ?></td>
      <td><button class="pay">Charge card</button></td>
    </tr>
  <?php endwhile; ?>
  </table>
</body>
</html>
