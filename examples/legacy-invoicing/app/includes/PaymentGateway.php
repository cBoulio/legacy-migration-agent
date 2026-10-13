<?php
require_once __DIR__ . '/config.php';

class PaymentGateway {
    private $client;

    public function __construct() {
        $this->client = new SoapClient(PAYGATE_WSDL, array('trace' => 1, 'exceptions' => true));
    }

    public function charge($invoiceId, $amountCents, $cardToken) {
        return $this->client->Charge(array(
            'MerchantId' => PAYGATE_MERCHANT_ID,
            'ApiKey'     => PAYGATE_API_KEY,
            'Reference'  => 'INV-' . $invoiceId,
            'Amount'     => $amountCents,
            'Token'      => $cardToken,
        ));
    }

    public function refund($transactionId) {
        return $this->client->Refund(array('MerchantId' => PAYGATE_MERCHANT_ID, 'TransactionId' => $transactionId));
    }
}
