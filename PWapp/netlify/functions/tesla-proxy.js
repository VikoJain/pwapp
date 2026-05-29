const https = require('https');

exports.handler = async (event) => {
  const { path, method, body, token } = JSON.parse(event.body || '{}');
  
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  };

  return new Promise((resolve) => {
    const url = new URL(path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: data
        });
      });
    });

    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: e.message })
      });
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
};
