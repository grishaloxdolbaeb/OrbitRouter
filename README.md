# Orbit Router

Небольшой OpenAI-совместимый AI-роутер для Render. Он принимает ключи, выданные друзьям, ограничивает частоту запросов и переключается между эквивалентными моделями разных провайдеров.

## Возможности

- `POST /v1/chat/completions` с обычными и потоковыми ответами.
- `GET /v1/models` со списком доступных моделей.
- Bearer-авторизация ключами `rtr_...`.
- Индивидуальные ограничения RPM и доступных моделей.
- Явный fallback только между эквивалентными моделями.
- Dashboard со статистикой в памяти: `/dashboard`.
- Ключи провайдеров хранятся только в Render Environment.

## Переменные Render

Обязательные:

```text
ADMIN_KEY=длинный-случайный-пароль
ROUTER_API_KEYS=rtr_ключ_для_тебя,rtr_ключ_для_друга
```

Добавь хотя бы один ключ провайдера:

```text
FISHAPPEDU_API_KEY=sk-cxr-...
OPENROUTER_API_KEY=sk-or-v1-...
```

Для разных лимитов используй `ROUTER_KEYS_JSON` вместо `ROUTER_API_KEYS`:

```json
[
  {
    "name": "owner",
    "key": "rtr_очень-длинный-случайный-ключ",
    "rpm": 100
  },
  {
    "name": "friend",
    "key": "rtr_другой-длинный-ключ",
    "rpm": 20,
    "models": ["orbit-auto", "gpt-5.5"]
  }
]
```

Если заданы обе переменные, используется `ROUTER_KEYS_JSON`.

## Деплой

1. Отправь файлы в GitHub.
2. В Render выбери `New` → `Blueprint` и подключи репозиторий.
3. Введи секретные `FISHAPPEDU_API_KEY` и/или `OPENROUTER_API_KEY`.
4. После деплоя открой `https://имя-сервиса.onrender.com/health`.
5. Открой `/dashboard` и введи значение `ADMIN_KEY`.

`render.yaml` автоматически создаёт случайные `ADMIN_KEY` и `ROUTER_API_KEYS`. Значение сгенерированного `ROUTER_API_KEYS` можно посмотреть и заменить в Environment сервиса.

## Использование

```bash
curl https://имя-сервиса.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer rtr_твой-ключ" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "orbit-auto",
    "messages": [{"role":"user","content":"Привет!"}],
    "stream": false
  }'
```

Поддерживаемые публичные ID зависят от настроенных провайдеров. Получить фактический список:

```bash
curl https://имя-сервиса.onrender.com/v1/models \
  -H "Authorization: Bearer rtr_твой-ключ"
```

`orbit-auto` сначала использует `gpt-5.6-sol` Fishappedu, затем эквивалентную `openai/gpt-5.6-sol` OpenRouter.

## Безопасность

- Никогда не добавляй `.env` или реальные ключи в GitHub.
- Для каждого друга лучше создать отдельную запись в `ROUTER_KEYS_JSON`.
- При утечке удали ключ из переменной и перезапусти сервис.
- `CORS_ORIGINS=*` подходит для личного API. Позже замени `*` на домен своего чата.
- Бесплатный Render перезапускается и засыпает, поэтому статистика в dashboard непостоянная.

## Локальный запуск

```bash
npm install
copy .env.example .env
npm start
```

API будет доступен на `http://localhost:3000`.

## OmniRoute

`localhost:20128` на твоём компьютере недоступен серверу Render. OmniRoute можно подключить только если он запущен по публичному HTTPS URL. Тогда установи:

```text
OMNIROUTE_BASE_URL=https://твой-публичный-omniroute.example/v1
OMNIROUTE_API_KEY=...
```
