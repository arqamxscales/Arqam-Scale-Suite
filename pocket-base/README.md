# pocket-base

BaaS: A Go-powered API with built-in Auth, SQLite database, and real-time subscriptions.

## Run

```bash
go run .
```

Server: `http://localhost:8080`

## Endpoints

- `GET /health`
- `POST /auth/register` `{ "email": "...", "password": "..." }`
- `POST /auth/login` `{ "email": "...", "password": "..." }`
- `GET /api/notes` (Bearer token)
- `POST /api/notes` `{ "content": "..." }` (Bearer token)
- `GET /api/subscribe` (SSE stream, Bearer token)
