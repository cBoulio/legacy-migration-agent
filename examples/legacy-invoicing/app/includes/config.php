<?php
// Global configuration. Edit on the server, never committed to a secrets store.
define('DB_HOST', 'db01.internal.example');
define('DB_NAME', 'invoicing');
define('DB_USER', 'invoicing_app');
define('DB_PASS', 'Winter2013!');

define('SMTP_HOST', 'smtp.mail.example');
define('SMTP_USER', 'billing@acme.example');
define('SMTP_PASS', 'mailpass123');

define('PAYGATE_WSDL', 'https://soap.paygate.example/v1/PaymentService?wsdl');
define('PAYGATE_MERCHANT_ID', 'ACME-0042');
define('PAYGATE_API_KEY', 'pg-key-0000-fixture-not-real');

define('LATE_FEE_PERCENT', 1.5);
define('PDF_DIR', '/var/www/invoicing/storage/pdf');
