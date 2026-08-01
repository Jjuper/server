require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { RouterOSClient } = require('routeros-api');

const app = express();
app.use(express.json());
app.use(cors());

// In-memory store (Replace with a DB like Redis/MongoDB for high volume)
const transactions = {};

const getTimestamp = () => {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
};

// Fetch Safaricom OAuth Token
const getAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const response = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
};

// Function: Unlock User MAC on MikroTik
async function authorizeMacOnMikrotik(macAddress, durationHours = 1) {
  const api = new RouterOSClient({
    host: process.env.MIKROTIK_HOST,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASS,
    port: parseInt(process.env.MIKROTIK_PORT) || 8728,
    timeout: 10,
  });

  try {
    const client = await api.connect();
    
    // Add bypass rule in MikroTik Hotspot
    await client.menu('/ip hotspot ip-binding').add({
      'mac-address': macAddress,
      'type': 'bypassed',
      'comment': `M-Pesa Paid (${durationHours}h) - ${new Date().toISOString()}`
    });

    console.log(`🚀 [MikroTik] Access granted to MAC: ${macAddress}`);
    api.close();
  } catch (err) {
    console.error('❌ [MikroTik API Error]:', err.message);
  }
}

// 1. INITIATE STK PUSH (Triggered by hotspot login.html)
app.post('/api/stkpush', async (req, res) => {
  const { phone, amount, mac } = req.body;

  let formattedPhone = phone.trim().replace('+', '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = `254${formattedPhone.substring(1)}`;
  }

  const timestamp = getTimestamp();
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');

  try {
    const token = await getAccessToken();

    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount),
      PartyA: formattedPhone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: mac || 'WiFiHotspot',
      TransactionDesc: 'WiFi Access',
    };

    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutID = response.data.CheckoutRequestID;
    
    transactions[checkoutID] = {
      status: 'PENDING',
      mac: mac,
      phone: formattedPhone,
      amount: amount
    };

    res.status(200).json({
      success: true,
      checkoutRequestID: checkoutID,
      message: 'STK push sent.',
    });
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: 'STK Push failed.' });
  }
});

// 2. DARJA WEBHOOK CALLBACK
app.post('/api/callback', async (req, res) => {
  // Acknowledge Safaricom immediately
  res.status(200).send({ ResultCode: 0, ResultDesc: 'Accepted' });

  const callbackData = req.body?.Body?.stkCallback;
  if (!callbackData) return;

  const checkoutID = callbackData.CheckoutRequestID;
  const resultCode = callbackData.ResultCode;

  if (resultCode === 0) {
    const metadata = callbackData.CallbackMetadata.Item;
    const mpesaReceipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
    
    console.log(`✅ Payment SUCCESS for CheckoutID: ${checkoutID} | Receipt: ${mpesaReceipt}`);
    
    if (transactions[checkoutID]) {
      transactions[checkoutID].status = 'SUCCESS';
      transactions[checkoutID].mpesaReceipt = mpesaReceipt;
      
      // Trigger RouterOS provisioning
      const userMac = transactions[checkoutID].mac;
      if (userMac) {
        await authorizeMacOnMikrotik(userMac, 1);
      }
    }
  } else {
    console.log(`❌ Payment FAILED for CheckoutID: ${checkoutID}`);
    if (transactions[checkoutID]) {
      transactions[checkoutID].status = 'FAILED';
    }
  }
});

// 3. STATUS POLLING ENDPOINT
app.get('/api/status/:checkoutID', (req, res) => {
  const tx = transactions[req.params.checkoutID];
  if (!tx) return res.status(404).json({ success: false, message: 'Not found' });
  res.status(200).json({ success: true, transaction: tx });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Cloud Server running on port ${PORT}`));