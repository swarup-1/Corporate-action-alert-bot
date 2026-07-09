const https = require('https');
const axios = require('axios');

const allowInsecureSsl = process.env.ALLOW_INSECURE_SSL === 'true';

const httpsAgent = new https.Agent({
  rejectUnauthorized: !allowInsecureSsl,
  // BSE API sometimes returns headers that trip Node's strict parser (esp. behind corporate proxy)
  insecureHTTPParser: true,
});

if (allowInsecureSsl) {
  console.warn('⚠️  ALLOW_INSECURE_SSL=true — SSL verification disabled for NSE/BSE/Yahoo requests');
}

function createHttpClient(config = {}) {
  return axios.create({
    httpsAgent,
    ...config,
  });
}

function httpGet(url, config = {}) {
  return axios.get(url, { httpsAgent, ...config });
}

module.exports = { createHttpClient, httpGet, httpsAgent };
