async function createSnapTransaction({ serverKey, environment, orderId, amount, packageType, itemName }) {
  const isProd = environment === 'production';
  const url = isProd
    ? 'https://app.midtrans.com/snap/v1/transactions'
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

  const authHeader = 'Basic ' + Buffer.from(`${serverKey}:`).toString('base64');
  const payload = {
    transaction_details: { order_id: orderId, gross_amount: amount },
    customer_details: { first_name: 'Photobinc', last_name: 'User', notes: 'Self Studio Session' },
    item_details: [{ id: packageType, price: amount, quantity: 1, name: itemName }],
    enabled_payments: isProd ? ['qris'] : ['bca_va', 'qris'],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok || !json.token) {
    const errMsg = Array.isArray(json.error_messages)
      ? json.error_messages.join(', ')
      : 'Gagal membuat token Midtrans.';
    throw new Error(errMsg);
  }
  return json.token;
}

async function checkMidtransStatus({ serverKey, environment, orderId }) {
  const isProd = environment === 'production';
  const url = isProd
    ? `https://api.midtrans.com/v2/${encodeURIComponent(orderId)}/status`
    : `https://api.sandbox.midtrans.com/v2/${encodeURIComponent(orderId)}/status`;

  const authHeader = 'Basic ' + Buffer.from(`${serverKey}:`).toString('base64');
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: authHeader },
  });
  if (!res.ok) return 'pending';
  const json = await res.json();
  const stat = String(json.transaction_status || '').toLowerCase().trim();
  if (['settlement', 'capture', 'success'].includes(stat)) return 'lunas';
  if (['cancel', 'deny', 'expire'].includes(stat)) return 'cancelled';
  return 'pending';
}

module.exports = {
  createSnapTransaction,
  checkMidtransStatus,
};