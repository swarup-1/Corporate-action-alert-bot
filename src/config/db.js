const mongoose = require('mongoose');

let connected = false;

function getMongoOptions() {
  const allowInsecureSsl = process.env.ALLOW_INSECURE_SSL === 'true';
  return {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4,
    ...(allowInsecureSsl && { tlsAllowInvalidCertificates: true }),
  };
}

async function connectMongo(uri = process.env.MONGODB_URI) {
  if (!uri) {
    throw new Error('MONGODB_URI is required in .env');
  }

  if (mongoose.connection.readyState === 1) {
    connected = true;
    return mongoose.connection;
  }

  await mongoose.connect(uri, getMongoOptions());
  connected = true;
  return mongoose.connection;
}

function isDbConnected() {
  return connected && mongoose.connection.readyState === 1;
}

module.exports = { connectMongo, getMongoOptions, isDbConnected };
