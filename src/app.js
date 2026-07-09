require('dotenv').config();
const express = require('express');
const cors = require('cors');
const dividendRoutes = require('./routes/dividends');
const { connectMongo } = require('./config/db');

let dbInitPromise = null;

async function ensureDatabase(app) {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      let dbReady = false;
      try {
        await connectMongo();
        dbReady = true;
        console.log('MongoDB connected');
      } catch (err) {
        console.warn('MongoDB unavailable:', err.message);
      }
      app.set('dbReady', dbReady);
    })();
  }

  await dbInitPromise;
}

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use(async (req, res, next) => {
    await ensureDatabase(app);
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      db: req.app.get('dbReady') ? 'connected' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api/dividends', dividendRoutes);

  return app;
}

module.exports = { createApp };
