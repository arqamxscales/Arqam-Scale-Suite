# Arqam-Scale-Suite 
**Developer:** @arqamxscales  
**Focus:** AI Infrastructure, Fintech Scalability, & Open Source Tooling.

This monorepo is a comprehensive collection of self-hosted services inspired by industry leaders. It is designed to provide a "Backend-in-a-Box" for AI Engineers.

## 📂 Directory Map
| Service | Folder | Inspiration | Core Tech |
| :--- | :--- | :--- | :--- |
| **Background Jobs** | `/trigger-bg` | Trigger.dev | TypeScript, BullMQ |
| **Link Management** | `/dub-links` | Dub.co | Next.js, Prisma |
| **Self-hosted PaaS** | `/coolify-paas` | Coolify | Docker, Bash |
| **Single-File Backend**| `/pocket-base` | PocketBase | Go, SQLite |
| **Real-time Chat** | `/paper-cups` | Papercups | WebSockets, React |
| **API Testing** | `/hopp-test` | Hoppscotch | Vue.js, TS |

## 🛠 Global Setup
1. Clone: `git clone https://github.com/arqamxscales/Arqam-Scale-Suite`
2. Run all services: `docker compose up -d --build`

## ✅ Current Scaffold Status
- Monorepo folders created for all 6 services.
- Docker Compose orchestration created with Apple Silicon defaults (`linux/arm64`).
- Baseline production hardening applied in compose:
	- restart policy (`unless-stopped`)
	- service healthchecks
	- dependency health-gating where needed
	- persistent Postgres volume for `dub-links`
- Current service capabilities:
	- `trigger-bg` (authenticated enqueue + job lifecycle/status/result APIs)
	- `dub-links` (persistent Postgres short links + API key auth + redirect analytics)
	- `pocket-base` (Go + SQLite auth/notes/realtime API)
	- `paper-cups` (WebSocket chat relay)
	- `coolify-paas` (PaaS control-plane stub)
	- `hopp-test` (API testing workspace stub)

## 🧪 How to Test

### 1) Build and start everything

```bash
docker compose up -d --build
```

### 2) Check container health

```bash
docker compose ps
```

### 3) Run full smoke test (recommended)

```bash
bash scripts/smoke-test.sh
```

This verifies health + key workflows for all services:
- `trigger-bg`: auth enforcement + enqueue + job detail/result
- `dub-links`: create link + fetch + redirect
- `pocket-base`: register + login
- `coolify-paas`, `hopp-test`, `paper-cups`: service endpoints

### 4) View logs if something fails

```bash
docker compose logs -f
```

