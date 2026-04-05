# trigger-bg

Background jobs service using BullMQ + Redis with authenticated enqueue and job status/result APIs.

## Run

```bash
npm start
```

## Endpoints

- `GET /health`
- `POST /api/jobs` (requires `X-API-Key`)
- `GET /api/jobs?state=waiting&limit=20`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/result`

## Auth

Set `TRIGGER_API_KEY` and pass it via `X-API-Key` for enqueue operations.
