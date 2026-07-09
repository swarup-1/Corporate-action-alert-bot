/**
 * MongoDB connection diagnostic — run: node src/scripts/test-db.js
 * Does NOT print your password.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const dns = require('dns').promises;
const { getMongoOptions } = require('../config/db');

const uri = process.env.MONGODB_URI;

const https = require('https');

async function getPublicIp() {
  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip'];

  for (const url of urls) {
    try {
      const ip = await new Promise((resolve, reject) => {
        https
          .get(url, { timeout: 5000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => resolve(body.trim()));
          })
          .on('error', reject);
      });
      if (ip) return ip;
    } catch {
      // try next provider
    }
  }

  return '(could not detect — check Atlas Network Access → 0.0.0.0/0)';
}

async function main() {
  if (!uri) {
    console.error('❌ MONGODB_URI missing in .env');
    process.exit(1);
  }

  const publicIp = await getPublicIp();
  console.log('Your public IP:', publicIp);
  console.log('Add this IP in Atlas → Network Access, or use 0.0.0.0/0 (allow all)\n');

  const hostMatch = uri.match(/@([^/]+)/);
  const host = hostMatch?.[1];
  console.log('Cluster host:', host);

  try {
    const srvHost = `_mongodb._tcp.${host}`;
    const records = await dns.resolveSrv(srvHost);
    console.log('✅ DNS SRV resolved:', records.length, 'record(s)');
    records.forEach((r) => console.log('   →', r.name, 'port', r.port));
  } catch (e) {
    console.error('❌ DNS SRV failed:', e.message);
    console.error('   Your network may block MongoDB DNS. Try mobile hotspot or home WiFi.');
  }

  if (process.env.ALLOW_INSECURE_SSL === 'true') {
    console.log('\n⚠️  ALLOW_INSECURE_SSL=true — TLS cert validation relaxed for MongoDB');
  }

  console.log('\nConnecting to MongoDB (30s timeout)...');
  try {
    await mongoose.connect(uri, getMongoOptions());
    console.log('✅ MongoDB connected successfully!');
    console.log('   Database:', mongoose.connection.name);
    await mongoose.disconnect();
  } catch (e) {
    console.error('\n❌ Connection failed:', e.message);
    if (e.reason?.servers) {
      for (const [addr, desc] of e.reason.servers) {
        console.error('   Server', addr, '→', desc.error?.message || desc.type);
      }
    }
    console.error('\nCommon fixes:');
    console.error('  1. Atlas → Network Access → add', publicIp, 'or 0.0.0.0/0');
    console.error('  2. Turn OFF corporate VPN; mobile hotspot alone often works');
    console.error('  3. Set ALLOW_INSECURE_SSL=true if office proxy intercepts TLS');
    console.error('  4. Wait 2–3 min after changing Network Access');
    process.exit(1);
  }
}

main();
