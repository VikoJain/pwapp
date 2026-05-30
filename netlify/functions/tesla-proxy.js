const https = require('https');
const crypto = require('crypto');

// Sign a Tesla command with the private key
function signCommand(privateKeyPem, body) {
  try {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyStr = body ? JSON.stringify(body) : '';
    const message = timestamp + nonce + bodyStr;
    const sign = crypto.createSign('SHA256');
    sign.update(message);
    const signature = sign.sign(privateKey, 'base64');
    return { timestamp, nonce, signature };
  } catch(e) {
    console.error('Signing error:', e.message);
    return null;
  }
}

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const { path, method, body, token } = JSON.parse(event.body || '{}');
    if (!path || !token) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing path or token' }) };
    }

    const url = new URL(path);
    const isCommand = method === 'POST' && (
      path.includes('/operation') ||
      path.includes('/backup') ||
      path.includes('/off_grid_vehicle_charging_reserve') ||
      path.includes('/storm_mode') ||
      path.includes('/tariff_rate')
    );

    const headers = {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    };

    // Add command signing headers if this is a command and we have a private key
    if (isCommand && process.env.TESLA_PRIVATE_KEY) {
      const signed = signCommand(process.env.TESLA_PRIVATE_KEY, body);
      if (signed) {
        headers['X-Tesla-Timestamp'] = signed.timestamp;
        headers['X-Tesla-Nonce'] = signed.nonce;
        headers['X-Tesla-Signature'] = signed.signature;
      }
    }

    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: {
        ...headers,
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };

    const result = await makeRequest(options, postData);

    // If command signing failed, try without signing
    let responseBody = result.body;
    try {
      const parsed = JSON.parse(result.body);
      // If we get a signing error, log it for debugging
      if (parsed.error && isCommand) {
        console.log('Command response:', result.statusCode, parsed.error);
      }
    } catch(e) {}

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: responseBody
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: e.message })
    };
  }
};
