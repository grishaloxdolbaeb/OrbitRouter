require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');

const app = express();
const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();

app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
}));

const providerDefinitions = [
  {
    id: 'fishappedu',
    baseUrl: process.env.FISHAPPEDU_BASE_URL || 'https://fishappedu.online/v1',
    apiKey: process.env.FISHAPPEDU_API_KEY,
    models: ['gpt-5.6-sol', 'gpt-5.5'],
  },
  {
    id: 'openrouter',
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    models: [
      'openai/gpt-oss-120b',
      'openai/gpt-5.6-luna-pro',
      'openai/gpt-5.6-sol',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
    ],
    headers: {
      'HTTP-Referer': process.env.PUBLIC_URL || 'https://orbit-router.onrender.com',
      'X-Title': 'Orbit Router',
    },
  },
  {
    id: 'omniroute',
    baseUrl: process.env.OMNIROUTE_BASE_URL,
    apiKey: process.env.OMNIROUTE_API_KEY,
    models: ['kr/claude-sonnet-4.5'],
  },
];

const providers = providerDefinitions
  .filter((provider) => provider.apiKey && provider.baseUrl)
  .map((provider) => ({
    ...provider,
    baseUrl: provider.baseUrl.replace(/\/$/, ''),
  }));

// Public model aliases can fall back to equivalent models at another provider.
const modelRoutes = {
  'orbit-auto': [
    ['fishappedu', 'gpt-5.6-sol'],
    ['openrouter', 'openai/gpt-5.6-sol'],
  ],
  'gpt-5.6-sol': [
    ['fishappedu', 'gpt-5.6-sol'],
    ['openrouter', 'openai/gpt-5.6-sol'],
  ],
  'gpt-5.5': [['fishappedu', 'gpt-5.5']],
  'openai/gpt-oss-120b': [['openrouter', 'openai/gpt-oss-120b']],
  'openai/gpt-5.6-luna-pro': [['openrouter', 'openai/gpt-5.6-luna-pro']],
  'openai/gpt-5.6-sol': [
    ['openrouter', 'openai/gpt-5.6-sol'],
    ['fishappedu', 'gpt-5.6-sol'],
  ],
  'anthropic/claude-fable-5': [['openrouter', 'anthropic/claude-fable-5']],
  'anthropic/claude-sonnet-5': [['openrouter', 'anthropic/claude-sonnet-5']],
  'kr/claude-sonnet-4.5': [['omniroute', 'kr/claude-sonnet-4.5']],
};

function parseAccessKeys() {
  if (process.env.ROUTER_KEYS_JSON) {
    try {
      const records = JSON.parse(process.env.ROUTER_KEYS_JSON);
      if (!Array.isArray(records)) throw new Error('value must be an array');
      return records
        .filter((record) => record && record.key)
        .map((record) => ({
          name: record.name || 'user',
          key: String(record.key),
          rpm: Math.max(1, Number(record.rpm || 60)),
          models: Array.isArray(record.models) ? record.models : null,
        }));
    } catch (error) {
      console.error(`Invalid ROUTER_KEYS_JSON: ${error.message}`);
    }
  }

  return (process.env.ROUTER_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key, index) => ({ name: `user-${index + 1}`, key, rpm: 60, models: null }));
}

const accessKeys = parseAccessKeys();
const rateWindows = new Map();
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  byProvider: {},
  recent: [],
};

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '');
  const rightBuffer = Buffer.from(right || '');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const record = accessKeys.find((candidate) => safeEqual(candidate.key, token));

  if (!record) {
    return res.status(401).json({
      error: { message: 'Invalid router API key', type: 'authentication_error' },
    });
  }

  const now = Date.now();
  const hash = crypto.createHash('sha256').update(record.key).digest('hex').slice(0, 16);
  const window = rateWindows.get(hash);
  if (!window || now - window.startedAt >= 60_000) {
    rateWindows.set(hash, { startedAt: now, count: 1 });
  } else if (window.count >= record.rpm) {
    res.set('Retry-After', String(Math.ceil((60_000 - (now - window.startedAt)) / 1000)));
    return res.status(429).json({
      error: { message: `Rate limit exceeded (${record.rpm} requests/minute)`, type: 'rate_limit_error' },
    });
  } else {
    window.count += 1;
  }

  req.routerUser = { ...record, key: undefined, hash };
  return next();
}

function verifyAdmin(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !safeEqual(req.get('x-admin-key'), adminKey)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

function availableRoutes(model) {
  const configured = new Map(providers.map((provider) => [provider.id, provider]));
  return (modelRoutes[model] || [])
    .map(([providerId, upstreamModel]) => ({ provider: configured.get(providerId), upstreamModel }))
    .filter((route) => route.provider);
}

function recordRequest(entry) {
  stats.total += 1;
  stats[entry.status === 'success' ? 'success' : 'failed'] += 1;
  stats.inputTokens += entry.inputTokens || 0;
  stats.outputTokens += entry.outputTokens || 0;

  const providerStats = stats.byProvider[entry.provider] || { total: 0, success: 0, failed: 0 };
  providerStats.total += 1;
  providerStats[entry.status === 'success' ? 'success' : 'failed'] += 1;
  stats.byProvider[entry.provider] = providerStats;

  stats.recent.unshift({ ...entry, at: new Date().toISOString() });
  stats.recent.length = Math.min(stats.recent.length, 100);
}

async function callProvider(route, body, signal) {
  return fetch(`${route.provider.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${route.provider.apiKey}`,
      'Content-Type': 'application/json',
      ...(route.provider.headers || {}),
    },
    body: JSON.stringify({ ...body, model: route.upstreamModel }),
  });
}

app.get('/', (req, res) => {
  res.json({
    name: 'Orbit Router',
    status: 'online',
    docs: '/v1/models',
    dashboard: '/dashboard',
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', providers: providers.map((provider) => provider.id) });
});

app.get('/v1/models', authenticate, (req, res) => {
  const models = Object.keys(modelRoutes)
    .filter((model) => availableRoutes(model).length > 0)
    .filter((model) => !req.routerUser.models || req.routerUser.models.includes(model))
    .map((id) => ({ id, object: 'model', created: Math.floor(startedAt / 1000), owned_by: 'orbit-router' }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', authenticate, async (req, res) => {
  const { model, messages, stream = false, ...parameters } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: '`model` and `messages` are required', type: 'invalid_request_error' },
    });
  }
  if (req.routerUser.models && !req.routerUser.models.includes(model)) {
    return res.status(403).json({
      error: { message: 'This API key cannot use the requested model', type: 'permission_error' },
    });
  }

  const routes = availableRoutes(model);
  if (routes.length === 0) {
    return res.status(404).json({
      error: { message: `Model is unavailable: ${model}`, type: 'invalid_request_error' },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REQUEST_TIMEOUT_MS || 180_000));
  req.on('aborted', () => controller.abort());
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const failures = [];

  try {
    for (const route of routes) {
      const attemptStartedAt = Date.now();
      try {
        const upstream = await callProvider(route, { messages, stream: Boolean(stream), ...parameters }, controller.signal);
        if (!upstream.ok) {
          const detail = await upstream.text();
          failures.push(`${route.provider.id}: HTTP ${upstream.status}`);
          recordRequest({
            user: req.routerUser.name,
            provider: route.provider.id,
            model: route.upstreamModel,
            status: 'failed',
            statusCode: upstream.status,
            latencyMs: Date.now() - attemptStartedAt,
          });
          console.warn(`Provider failed: ${route.provider.id} ${upstream.status} ${detail.slice(0, 300)}`);
          continue;
        }

        res.set('x-orbit-provider', route.provider.id);
        res.set('x-orbit-model', route.upstreamModel);

        if (stream) {
          res.status(200);
          res.set('Content-Type', upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8');
          res.set('Cache-Control', 'no-cache, no-transform');
          res.set('Connection', 'keep-alive');
          res.flushHeaders();

          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
          recordRequest({
            user: req.routerUser.name,
            provider: route.provider.id,
            model: route.upstreamModel,
            status: 'success',
            streaming: true,
            latencyMs: Date.now() - attemptStartedAt,
          });
          return;
        }

        const data = await upstream.json();
        const usage = data.usage || {};
        recordRequest({
          user: req.routerUser.name,
          provider: route.provider.id,
          model: route.upstreamModel,
          status: 'success',
          inputTokens: usage.prompt_tokens || usage.input_tokens || 0,
          outputTokens: usage.completion_tokens || usage.output_tokens || 0,
          latencyMs: Date.now() - attemptStartedAt,
        });
        return res.json(data);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        failures.push(`${route.provider.id}: ${error.message}`);
        recordRequest({
          user: req.routerUser.name,
          provider: route.provider.id,
          model: route.upstreamModel,
          status: 'failed',
          latencyMs: Date.now() - attemptStartedAt,
        });
      }
    }

    return res.status(502).json({
      error: { message: `All routes failed: ${failures.join('; ')}`, type: 'upstream_error' },
    });
  } catch (error) {
    if (!res.headersSent) {
      return res.status(controller.signal.aborted ? 504 : 502).json({
        error: { message: controller.signal.aborted ? 'Request timed out' : error.message, type: 'upstream_error' },
      });
    }
    return res.end();
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/admin/stats', verifyAdmin, (req, res) => {
  res.json({
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    configuredProviders: providers.map((provider) => provider.id),
    users: accessKeys.map(({ name, rpm, models }) => ({ name, rpm, models: models || 'all' })),
    ...stats,
  });
});

app.get('/dashboard', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orbit Router</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0d0f14;color:#eef0f6;font:14px/1.5 system-ui}.shell{max-width:1050px;margin:auto;padding:32px 20px}h1{font-size:28px}.login,.card{background:#171a22;border:1px solid #292e3b;border-radius:15px;padding:20px;margin:16px 0}.row{display:flex;gap:10px}input{flex:1;padding:11px;border:1px solid #343a49;border-radius:9px;background:#101218;color:#fff}button{padding:11px 17px;border:0;border-radius:9px;background:#7656ff;color:#fff;font-weight:700;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.stat{background:#101218;border-radius:11px;padding:15px}.stat b{display:block;font-size:23px}.muted{color:#929aaa}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #292e3b}@media(max-width:600px){.row{flex-direction:column}}</style></head>
<body><main class="shell"><h1>Orbit Router</h1><p class="muted">Статистика хранится в памяти и сбрасывается при перезапуске бесплатного Render instance.</p><section class="login"><div class="row"><input id="key" type="password" placeholder="ADMIN_KEY"><button id="load">Открыть dashboard</button></div><p id="error" style="color:#ff7180"></p></section><section id="content" hidden><div class="grid" id="summary"></div><div class="card"><h2>Провайдеры</h2><pre id="providers"></pre></div><div class="card"><h2>Последние запросы</h2><div style="overflow:auto"><table><thead><tr><th>Время</th><th>Пользователь</th><th>Провайдер</th><th>Модель</th><th>Статус</th><th>мс</th></tr></thead><tbody id="recent"></tbody></table></div></div></section></main>
<script>const e=id=>document.getElementById(id);e('key').value=sessionStorage.getItem('orbit-admin-key')||'';e('load').onclick=load;async function load(){e('error').textContent='';const key=e('key').value;const r=await fetch('/admin/stats',{headers:{'x-admin-key':key}});if(!r.ok){e('error').textContent='Неверный ADMIN_KEY';return}sessionStorage.setItem('orbit-admin-key',key);const d=await r.json();e('content').hidden=false;e('summary').innerHTML=[['Запросы',d.total],['Успешно',d.success],['Ошибки',d.failed],['Токены',d.inputTokens+d.outputTokens]].map(x=>'<div class="stat"><span class="muted">'+x[0]+'</span><b>'+x[1]+'</b></div>').join('');e('providers').textContent=JSON.stringify(d.byProvider,null,2);e('recent').innerHTML=d.recent.map(x=>'<tr><td>'+new Date(x.at).toLocaleString()+'</td><td>'+x.user+'</td><td>'+x.provider+'</td><td>'+x.model+'</td><td>'+x.status+'</td><td>'+x.latencyMs+'</td></tr>').join('')}if(e('key').value)load();</script></body></html>`);
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(error.message.includes('CORS') ? 403 : 500).json({
    error: { message: error.message, type: 'router_error' },
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Orbit Router listening on http://0.0.0.0:${port}`);
  console.log(`Configured providers: ${providers.map((provider) => provider.id).join(', ') || 'none'}`);
  console.log(`Configured user keys: ${accessKeys.length}`);
});
