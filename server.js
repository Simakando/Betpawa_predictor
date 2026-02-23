/**
 * Virtual Football Analytics Platform
 * Human-like behavior proxy server
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Cache with stale fallback
const cache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const staleCache = new NodeCache({ stdTTL: 300 });

// Human behavior config
const HUMAN = {
  minDelay: 2000,
  maxDelay: 5000,
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
  ]
};

// Utilities
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomDelay = () => sleep(random(HUMAN.minDelay, HUMAN.maxDelay));
const getUA = () => HUMAN.userAgents[random(0, HUMAN.userAgents.length - 1)];

// Request tracking
let requestCount = 0;
const canRequest = () => {
  if (requestCount > 25) {
    console.log('[SAFETY] Hourly limit reached, pausing...');
    return false;
  }
  return true;
};

// Reset counter hourly
setInterval(() => { requestCount = 0; }, 3600000);

// Middleware
app.use(helmet({ hidePoweredBy: { setTo: 'Apache/2.4.41' } }));
app.use(cors({ origin: true, credentials: false }));
app.use(express.json());

// BetPawa client
const client = axios.create({
  baseURL: 'https://www.betpawa.zm',
  timeout: 15000
});

// Add human-like behavior
client.interceptors.request.use(async (config) => {
  if (!canRequest()) {
    await sleep(60000); // Wait 1 minute if limit hit
    requestCount = 0;
  }
  
  // Random delay (2-5 seconds)
  await randomDelay();
  
  // Occasionally slower (checking phone, distracted)
  if (Math.random() > 0.85) {
    await sleep(random(5000, 8000));
    console.log('[HUMAN] Distracted delay...');
  }
  
  // Rotate user agent
  config.headers['User-Agent'] = getUA();
  config.headers['X-Pawa-Brand'] = 'betpawa-zambia';
  
  // Random viewport
  const viewports = ['1920x1080', '1366x768', '1440x900', '1536x864', '1280x720'];
  config.headers['Viewport-Width'] = viewports[random(0, viewports.length - 1)];
  
  requestCount++;
  return config;
});

// Cache key generator
const cacheKey = (req) => `${req.path}:${JSON.stringify(req.query)}`;

// Proxy function
async function proxy(req, res, endpoint) {
  const key = cacheKey(req);
  
  // Check fresh cache
  const fresh = cache.get(key);
  if (fresh) {
    res.set('X-Cache', 'HIT');
    return res.json(fresh);
  }
  
  // Check stale cache (serve while fetching)
  const stale = staleCache.get(key);
  
  try {
    const response = await client.get(endpoint, { params: req.query });
    
    if (response.data) {
      cache.set(key, response.data);
      staleCache.set(key, response.data);
      res.set('X-Cache', 'MISS');
      return res.json(response.data);
    }
    
    throw new Error('Empty response');
    
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    
    // Serve stale if available
    if (stale) {
      res.set('X-Cache', 'STALE');
      return res.json(stale);
    }
    
    res.status(503).json({ 
      error: 'Temporarily unavailable',
      retryAfter: 30
    });
  }
}

// Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    requestsThisHour: requestCount
  });
});

app.get('/api/sportsbook/virtual/v1/seasons/list/actual', (req, res) => {
  proxy(req, res, '/api/sportsbook/virtual/v1/seasons/list/actual');
});

app.get('/api/sportsbook/virtual/v2/events/list/by-round/:roundId', (req, res) => {
  const { roundId } = req.params;
  const page = req.query.page || 'upcoming';
  proxy(req, res, `/api/sportsbook/virtual/v2/events/list/by-round/${roundId}?page=${page}`);
});

// Serve frontend
app.use(express.static('public'));

// Error handling
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║  Virtual Football Analytics          ║
║  http://localhost:${PORT}              ║
╚══════════════════════════════════════╝
  `);
});