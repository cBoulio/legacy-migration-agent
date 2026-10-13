<?php
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/../vendor/phpmailer/phpmailer/PHPMailerAutoload.php';

function send_mail($to, $subject, $html, $attachment = null) {
    $mail = new PHPMailer();
    $mail->isSMTP();
    $mail->Host = SMTP_HOST;
    $mail->SMTPAuth = true;
    $mail->Username = SMTP_USER;
    $mail->Password = SMTP_PASS;
    $mail->setFrom('billing@acme.example', 'Acme Billing');
    $mail->addAddress($to);
    $mail->Subject = $subject;
    $mail->msgHTML($html);
    if ($attachment) {
        $mail->addAttachment($attachment);
    }
    return $mail->send();
}
