const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- SAFETY FEATURES ----------

// 1. Rotating User‑Agents
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
];

// 2. Cookie persistence
let cookieJar = {};

// 3. Failure tracking for exponential backoff
const failureCount = {};

// 4. Simple in‑memory cache (25 seconds)
const cache = new Map();
const CACHE_TTL = 25000;

// ---------- PROXY MIDDLEWARE ----------
app.use('/proxy', (req, res, next) => {
  const endpoint = req.url;

  // Check cache first
  const cached = cache.get(endpoint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[CACHE] Returning cached response for ${endpoint}`);
    return res.json(cached.data);
  }

  // Exponential backoff: if this endpoint failed too many times recently, block it
  if (failureCount[endpoint] > 3) {
    console.warn(`[BLOCKED] Endpoint ${endpoint} temporary disabled due to repeated failures`);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  // Random delay to vary request timing (500–1500ms)
  const delay = Math.floor(Math.random() * 1000) + 500;
  setTimeout(() => {
    // Pick a random User‑Agent
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Create proxy
    const proxy = createProxyMiddleware({
      target: 'https://sports.betpawa.co.zm',
      changeOrigin: true,
      onProxyReq: (proxyReq) => {
        // Add realistic headers
        proxyReq.setHeader('User-Agent', randomUA);
        proxyReq.setHeader('Accept', 'application/json, text/plain, */*');
        proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
        proxyReq.setHeader('Referer', 'https://sports.betpawa.co.zm/');
        proxyReq.setHeader('Origin', 'https://sports.betpawa.co.zm');
        proxyReq.setHeader('X-Pawa-Brand', 'betpawa-zambia');
        proxyReq.removeHeader('X-Forwarded-For');

        // Attach stored cookies if any
        if (Object.keys(cookieJar).length) {
          const cookieString = Object.entries(cookieJar)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
          proxyReq.setHeader('Cookie', cookieString);
        }
      },
      onProxyRes: (proxyRes) => {
        // Capture Set-Cookie headers
        const setCookie = proxyRes.headers['set-cookie'];
        if (setCookie) {
          setCookie.forEach(c => {
            const [keyval] = c.split(';');
            const [key, val] = keyval.split('=');
            cookieJar[key] = val;
          });
        }

        // Inspect response for blocking signals
        let body = '';
        proxyRes.on('data', chunk => { body += chunk; });
        proxyRes.on('end', () => {
          const contentType = proxyRes.headers['content-type'] || '';
          if (contentType.includes('text/html') && (body.includes('captcha') || body.includes('blocked') || body.includes('access denied'))) {
            console.error('[BLOCKED] BetPawa returned a blocking page');
            // Invalidate cache and mark failure
            cache.delete(endpoint);
            failureCount[endpoint] = (failureCount[endpoint] || 0) + 1;
          } else if (proxyRes.statusCode >= 400) {
            // Track HTTP errors
            failureCount[endpoint] = (failureCount[endpoint] || 0) + 1;
          } else {
            // Success: reset failure count
            delete failureCount[endpoint];
            // Cache the successful response
            try {
              const jsonData = JSON.parse(body);
              cache.set(endpoint, { timestamp: Date.now(), data: jsonData });
            } catch (e) {
              // Not JSON, don't cache
            }
          }
        });
      },
      onError: (err) => {
        console.error('[PROXY ERROR]', err);
        failureCount[endpoint] = (failureCount[endpoint] || 0) + 1;
        // Reset failure count after 60 seconds
        setTimeout(() => { delete failureCount[endpoint]; }, 60000);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Proxy error', details: err.message });
        }
      }
    });

    proxy(req, res, next);
  }, delay);
});

// Serve static files (including betpawa_predictor.html)
app.use(express.static(path.join(__dirname)));

// Fallback route to serve the main HTML
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'betpawa_predictor.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Secure proxy server running on port ${PORT}`);
});