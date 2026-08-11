require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Database setup
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const adapter = new FileSync(path.join(dataDir, 'db.json'));
const db = low(adapter);

db.defaults({
  users: [],
  api_keys: [],
  connected_accounts: [],
  usage_stats: [],
  oauth_states: []
}).write();

function getNextId(collection) {
  const items = db.get(collection).value();
  if (items.length === 0) return 1;
  return Math.max(...items.map(i => i.id)) + 1;
}

// Password hashing
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const verifyHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(verifyHash));
}

// Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

app.use(passport.initialize());

// Helper functions
function generateApiKey() {
  return `rtr_${crypto.randomBytes(32).toString('hex')}`;
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.get('users').find({ id: req.session.userId }).value();
    if (user) {
      req.user = user;
      return next();
    }
  }
  return res.status(401).json({ error: 'Authentication required' });
}

function getProviderConfig(userId) {
  const accounts = db.get('connected_accounts')
    .filter({ user_id: userId, is_active: true })
    .value();
  
  const providers = [];
  
  for (const account of accounts) {
    const key = account.api_key;
    switch (account.provider) {
      case 'openai':
        providers.push({ id: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: key, models: ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo'] });
        break;
      case 'openrouter':
        providers.push({
          id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: key,
          models: ['openai/gpt-oss-120b', 'openai/gpt-5.6-luna-pro', 'openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
          headers: { 'HTTP-Referer': BASE_URL, 'X-Title': 'Orbit Router' }
        });
        break;
      case 'fishappedu':
        providers.push({ id: 'fishappedu', baseUrl: 'https://fishappedu.online/v1', apiKey: key, models: ['gpt-5.6-sol', 'gpt-5.5'] });
        break;
      case 'kiro':
        providers.push({ id: 'kiro', baseUrl: process.env.KIRO_BASE_URL || 'https://api.kiro.ai/v1', apiKey: key, models: process.env.KIRO_MODELS ? process.env.KIRO_MODELS.split(',') : ['kr/claude-sonnet-4.5', 'kr/gpt-4o'] });
        break;
      case 'omniroute':
        providers.push({ id: 'omniroute', baseUrl: process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1', apiKey: key, models: ['kr/claude-sonnet-4.5'] });
        break;
    }
  }
  
  return providers;
}

// Auth routes
app.post('/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  const existing = db.get('users').find({ email: email.toLowerCase() }).value();
  if (existing) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  
  const { salt, hash } = hashPassword(password);
  
  const newUser = {
    id: getNextId('users'),
    email: email.toLowerCase(),
    name: name || email.split('@')[0],
    password_salt: salt,
    password_hash: hash,
    created_at: new Date().toISOString(),
    last_login: new Date().toISOString()
  };
  
  db.get('users').push(newUser).write();
  
  req.session.userId = newUser.id;
  
  res.json({
    success: true,
    user: { id: newUser.id, email: newUser.email, name: newUser.name }
  });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  
  const user = db.get('users').find({ email: email.toLowerCase() }).value();
  
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  
  db.get('users').find({ id: user.id }).assign({ last_login: new Date().toISOString() }).write();
  
  req.session.userId = user.id;
  
  res.json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name }
  });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/auth/status', (req, res) => {
  if (req.session && req.session.userId) {
    const user = db.get('users').find({ id: req.session.userId }).value();
    if (user) {
      return res.json({
        authenticated: true,
        user: { id: user.id, email: user.email, name: user.name }
      });
    }
  }
  res.json({ authenticated: false });
});

// OAuth routes for Kiro AI
app.get('/auth/kiro', requireAuth, (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  db.get('oauth_states').push({
    id: getNextId('oauth_states'),
    user_id: req.user.id,
    provider: 'kiro',
    state,
    created_at: new Date().toISOString()
  }).write();
  
  const params = new URLSearchParams({
    client_id: process.env.KIRO_CLIENT_ID || '',
    redirect_uri: `${BASE_URL}/auth/kiro/callback`,
    response_type: 'code',
    state,
    scope: 'api_access'
  });
  
  res.redirect(`https://kiro.ai/oauth/authorize?${params}`);
});

app.get('/auth/kiro/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  
  const storedState = db.get('oauth_states').find({ state, user_id: req.user.id, provider: 'kiro' }).value();
  if (!storedState) {
    return res.redirect('/dashboard?error=invalid_state');
  }
  
  db.get('oauth_states').remove({ id: storedState.id }).write();
  
  try {
    const tokenRes = await fetch('https://kiro.ai/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.KIRO_CLIENT_ID,
        client_secret: process.env.KIRO_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/kiro/callback`,
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenRes.json();
    
    if (tokenData.access_token) {
      const existing = db.get('connected_accounts').find({ user_id: req.user.id, provider: 'kiro' }).value();
      if (existing) {
        db.get('connected_accounts').find({ user_id: req.user.id, provider: 'kiro' }).assign({
          api_key: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          is_active: true,
          updated_at: new Date().toISOString()
        }).write();
      } else {
        db.get('connected_accounts').push({
          id: getNextId('connected_accounts'),
          user_id: req.user.id,
          provider: 'kiro',
          api_key: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).write();
      }
      res.redirect('/dashboard?connected=kiro');
    } else {
      res.redirect('/dashboard?error=kiro_auth_failed');
    }
  } catch (error) {
    res.redirect('/dashboard?error=kiro_auth_failed');
  }
});

// OAuth routes for ChatGPT (OpenAI)
app.get('/auth/openai', requireAuth, (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  db.get('oauth_states').push({
    id: getNextId('oauth_states'),
    user_id: req.user.id,
    provider: 'openai',
    state,
    created_at: new Date().toISOString()
  }).write();
  
  const params = new URLSearchParams({
    client_id: process.env.OPENAI_CLIENT_ID || '',
    redirect_uri: `${BASE_URL}/auth/openai/callback`,
    response_type: 'code',
    state,
    scope: 'openid email profile'
  });
  
  res.redirect(`https://auth.openai.com/oauth/authorize?${params}`);
});

app.get('/auth/openai/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  
  const storedState = db.get('oauth_states').find({ state, user_id: req.user.id, provider: 'openai' }).value();
  if (!storedState) {
    return res.redirect('/dashboard?error=invalid_state');
  }
  
  db.get('oauth_states').remove({ id: storedState.id }).write();
  
  try {
    const tokenRes = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.OPENAI_CLIENT_ID,
        client_secret: process.env.OPENAI_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/openai/callback`,
        grant_type: 'authorization_code'
      })
    });
    
    const tokenData = await tokenRes.json();
    
    if (tokenData.access_token) {
      const existing = db.get('connected_accounts').find({ user_id: req.user.id, provider: 'openai' }).value();
      if (existing) {
        db.get('connected_accounts').find({ user_id: req.user.id, provider: 'openai' }).assign({
          api_key: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          is_active: true,
          updated_at: new Date().toISOString()
        }).write();
      } else {
        db.get('connected_accounts').push({
          id: getNextId('connected_accounts'),
          user_id: req.user.id,
          provider: 'openai',
          api_key: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).write();
      }
      res.redirect('/dashboard?connected=openai');
    } else {
      res.redirect('/dashboard?error=openai_auth_failed');
    }
  } catch (error) {
    res.redirect('/dashboard?error=openai_auth_failed');
  }
});

// Pages
app.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// API Key management
app.get('/api/keys', requireAuth, (req, res) => {
  const keys = db.get('api_keys').filter({ user_id: req.user.id }).sortBy('created_at').reverse().value()
    .map(k => ({ id: k.id, name: k.name, key_prefix: k.key_prefix, is_active: k.is_active, created_at: k.created_at, last_used_at: k.last_used_at }));
  res.json(keys);
});

app.post('/api/keys', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const rawKey = generateApiKey();
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12) + '...';
  const newKey = { id: getNextId('api_keys'), user_id: req.user.id, name, key_hash: keyHash, key_prefix: keyPrefix, is_active: true, created_at: new Date().toISOString(), last_used_at: null };
  db.get('api_keys').push(newKey).write();
  res.json({ id: newKey.id, name, key: rawKey, key_prefix: keyPrefix, created_at: newKey.created_at });
});

app.delete('/api/keys/:id', requireAuth, (req, res) => {
  const key = db.get('api_keys').find({ id: parseInt(req.params.id), user_id: req.user.id }).value();
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.get('api_keys').remove({ id: parseInt(req.params.id) }).write();
  res.json({ success: true });
});

app.put('/api/keys/:id/toggle', requireAuth, (req, res) => {
  const key = db.get('api_keys').find({ id: parseInt(req.params.id), user_id: req.user.id }).value();
  if (!key) return res.status(404).json({ error: 'Key not found' });
  db.get('api_keys').find({ id: parseInt(req.params.id) }).assign({ is_active: !key.is_active }).write();
  res.json({ success: true });
});

// Connected accounts
app.get('/api/accounts', requireAuth, (req, res) => {
  const accounts = db.get('connected_accounts').filter({ user_id: req.user.id }).value();
  res.json(accounts);
});

app.post('/api/accounts', requireAuth, (req, res) => {
  const { provider, api_key } = req.body;
  const validProviders = ['openai', 'kiro', 'fishappedu', 'openrouter', 'omniroute'];
  if (!provider || !validProviders.includes(provider)) return res.status(400).json({ error: `Invalid provider. Valid: ${validProviders.join(', ')}` });
  if (!api_key) return res.status(400).json({ error: 'API key is required' });
  
  const existing = db.get('connected_accounts').find({ user_id: req.user.id, provider }).value();
  if (existing) {
    db.get('connected_accounts').find({ user_id: req.user.id, provider }).assign({ api_key, is_active: true, updated_at: new Date().toISOString() }).write();
  } else {
    db.get('connected_accounts').push({ id: getNextId('connected_accounts'), user_id: req.user.id, provider, api_key, is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).write();
  }
  res.json({ success: true, provider });
});

app.delete('/api/accounts/:provider', requireAuth, (req, res) => {
  const result = db.get('connected_accounts').remove({ user_id: req.user.id, provider: req.params.provider }).write();
  if (!result || result.length === 0) return res.status(404).json({ error: 'Account not found' });
  res.json({ success: true });
});

app.put('/api/accounts/:provider/toggle', requireAuth, (req, res) => {
  const account = db.get('connected_accounts').find({ user_id: req.user.id, provider: req.params.provider }).value();
  if (!account) return res.status(404).json({ error: 'Account not found' });
  db.get('connected_accounts').find({ user_id: req.user.id, provider: req.params.provider }).assign({ is_active: !account.is_active, updated_at: new Date().toISOString() }).write();
  res.json({ success: true });
});

// Models
app.get('/api/models', requireAuth, (req, res) => {
  const providers = getProviderConfig(req.user.id);
  const models = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      models.push({ id: model, provider: provider.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: provider.id });
    }
  }
  res.json({ object: 'list', data: models });
});

// Stats
app.get('/api/stats', requireAuth, (req, res) => {
  const userStats = db.get('usage_stats').filter({ user_id: req.user.id }).value();
  const totalReqs = userStats.length;
  const successReqs = userStats.filter(s => s.status === 'success').length;
  const totalTokens = userStats.reduce((sum, s) => sum + (s.input_tokens || 0) + (s.output_tokens || 0), 0);
  const byProvider = {};
  for (const stat of userStats) {
    if (!byProvider[stat.provider]) byProvider[stat.provider] = { requests: 0, tokens: 0 };
    byProvider[stat.provider].requests += 1;
    byProvider[stat.provider].tokens += (stat.input_tokens || 0) + (stat.output_tokens || 0);
  }
  const recent = db.get('usage_stats').filter({ user_id: req.user.id }).sortBy('created_at').reverse().take(50).value();
  res.json({ total_requests: totalReqs, successful_requests: successReqs, total_tokens: totalTokens, by_provider: byProvider, recent });
});

// Chat completions proxy
app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: { message: 'API key required', type: 'authentication_error' } });
  
  const keyHash = hashKey(token);
  const apiKeyRecord = db.get('api_keys').find({ key_hash: keyHash, is_active: true }).value();
  if (!apiKeyRecord) return res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
  
  db.get('api_keys').find({ id: apiKeyRecord.id }).assign({ last_used_at: new Date().toISOString() }).write();
  
  const { model, messages, stream = false, ...rest } = req.body;
  if (!model || !Array.isArray(messages)) return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } });
  
  const providers = getProviderConfig(apiKeyRecord.user_id);
  if (providers.length === 0) return res.status(400).json({ error: { message: 'No connected accounts. Please add API keys in dashboard.', type: 'configuration_error' } });
  
  let selectedProvider = null;
  for (const provider of providers) {
    if (provider.models.includes(model)) { selectedProvider = provider; break; }
  }
  if (!selectedProvider) return res.status(400).json({ error: { message: `Model "${model}" not available. Connect an account that supports this model.`, type: 'invalid_request_error' } });
  
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  
  try {
    const response = await fetch(`${selectedProvider.baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Authorization': `Bearer ${selectedProvider.apiKey}`, 'Content-Type': 'application/json', ...(selectedProvider.headers || {}) },
      body: JSON.stringify({ model, messages, stream, ...rest })
    });
    
    const logEntry = { id: getNextId('usage_stats'), user_id: apiKeyRecord.user_id, api_key_id: apiKeyRecord.id, provider: selectedProvider.id, model, input_tokens: 0, output_tokens: 0, status: 'error', latency_ms: Date.now() - startTime, created_at: new Date().toISOString() };
    
    if (!response.ok) {
      const errorText = await response.text();
      logEntry.status = 'error';
      db.get('usage_stats').push(logEntry).write();
      return res.status(response.status).json({ error: { message: `Provider error: ${errorText.slice(0, 500)}`, type: 'provider_error' } });
    }
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) { const { done, value } = await reader.read(); if (done) break; res.write(decoder.decode(value, { stream: true })); }
      res.end();
      logEntry.status = 'success';
      db.get('usage_stats').push(logEntry).write();
    } else {
      const data = await response.json();
      const usage = data.usage || {};
      logEntry.input_tokens = usage.prompt_tokens || 0;
      logEntry.output_tokens = usage.completion_tokens || 0;
      logEntry.status = 'success';
      db.get('usage_stats').push(logEntry).write();
      return res.json(data);
    }
  } catch (error) {
    db.get('usage_stats').push({ id: getNextId('usage_stats'), user_id: apiKeyRecord.user_id, api_key_id: apiKeyRecord.id, provider: selectedProvider.id, model, input_tokens: 0, output_tokens: 0, status: 'error', latency_ms: Date.now() - startTime, created_at: new Date().toISOString() }).write();
    if (!res.headersSent) return res.status(502).json({ error: { message: error.message, type: 'upstream_error' } });
  } finally {
    clearTimeout(timeout);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Orbit Router running on ${BASE_URL}`);
});