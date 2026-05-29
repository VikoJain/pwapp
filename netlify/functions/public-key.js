exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/x-pem-file',
      'Access-Control-Allow-Origin': '*'
    },
    body: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4Chn23ziNGgSUsZzSGSFnR6ANUlI
Lp+Jh9F8aRlPrvFJeodw+6Zuen4G/RKBpmLiIrsQYOt642NJBJVoZoc0tg==
-----END PUBLIC KEY-----`
  };
};
