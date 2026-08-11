# Orbit Router

AI Router с регистрацией по email, подключением аккаунтов Kiro AI / ChatGPT и управлением API ключами.

## Возможности

- **Регистрация по email** — простой вход без Google
- **Подключение аккаунтов** — Kiro AI, ChatGPT, OpenRouter, Fishappedu, OmniRoute
- **Управление API ключами** — создание ключей для друзей
- **Статистика** — запросы, токены, задержка
- **Проксирование** — использует подключённые аккаунты
- **Стриминг** — поддержка SSE

## Быстрый старт

### 1. Деплой на Render

1. Залей код на GitHub
2. На Render: **New** → **Web Service** → подключи GitHub
3. Render автоматически создаст `SESSION_SECRET`
4. Добавь `BASE_URL` (URL твоего приложения)

### 2. Использование

1. Открой сайт → **Регистрация**
2. Введи email и пароль
3. Перейди в **Подключённые аккаунты**
4. Добавь API ключ от Kiro AI, ChatGPT или другого провайдера
5. Создай ключ для друга в **Мои ключи**

## API Usage

```bash
curl https://your-app.onrender.com/v1/chat/completions \
  -H "Authorization: Bearer rtr_ключ_друга" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kr/claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

## Провайдеры

| Провайер | ID | Модели |
|----------|-----|--------|
| ChatGPT | `openai` | gpt-4o, gpt-4o-mini, gpt-4, gpt-3.5-turbo |
| Kiro AI | `kiro` | kr/claude-sonnet-4.5, kr/gpt-4o |
| OpenRouter | `openrouter` | gpt-oss-120b, gpt-5.6-luna-pro, gpt-5.6-sol, claude-fable-5, claude-sonnet-5 |
| Fishappedu | `fishappedu` | gpt-5.6-sol, gpt-5.5 |
| OmniRoute | `omniroute` | kr/claude-sonnet-4.5 |

## API Endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход |
| POST | `/auth/logout` | Выход |
| GET | `/auth/status` | Статус |
| GET | `/dashboard` | Панель управления |
| GET/POST | `/api/keys` | Ключи |
| GET/POST | `/api/accounts` | Аккаунты |
| GET | `/api/models` | Модели |
| GET | `/api/stats` | Статистика |
| POST | `/v1/chat/completions` | Запрос к AI |

## Локальный запуск

```bash
npm install
cp .env.example .env
npm start
```

Открой `http://localhost:3000`

## Лицензия

MIT