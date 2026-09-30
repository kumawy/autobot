# Развёртывание v1.1

Актуальные команды и порядок переноса описаны в [operations.md](operations.md), интеграции — в [integrations](integrations/whatsapp-telegram-sheets.md), обязательные проверки — в [production-readiness.md](production-readiness.md).

Используйте Node.js 24.21.0 и отдельные процессы `npm start` / `npm run worker` после `npm ci`, `npm run db:generate`, `npm run db:migrate`, `npm run build`. Настройки `.env.example` предназначены для локальной демонстрации.

Docker Compose запускает app+worker+PostgreSQL 18.4; это локальная конфигурация, привязанная к 127.0.0.1. При прежнем PostgreSQL 17 нельзя подключать старый физический volume к PostgreSQL 18: используйте логический dump/restore и отдельный новый volume.
