// Staff UI behaviour. Requires jQuery 1.7.
$(document).ready(function () {
  $('#invoices').delegate('button.pay', 'click', function () {
    var row = $(this).closest('tr');
    var token = prompt('Card token from terminal:');
    $.ajax({
      url: '/api/charge.php',
      type: 'POST',
      data: { invoice_id: row.data('id'), card_token: token },
      success: function (res) { row.find('td:eq(2)').text('paid'); },
      error: function () { alert('Charge failed'); }
    });
  });
});
