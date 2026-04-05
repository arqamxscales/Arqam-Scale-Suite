# Arqam-Scale-Suite 🚀
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
2. Run all services: `docker-compose up -d`

## ✅ Current Scaffold Status
- Monorepo folders created for all 6 services.
- Docker Compose orchestration created with Apple Silicon defaults (`linux/arm64`).
- Initial runnable scaffolds added for:
	- `trigger-bg` (BullMQ worker + enqueue endpoint)
	- `dub-links` (basic short-link API)
	- `pocket-base` (Go + SQLite auth/notes/realtime API)
	- `paper-cups` (WebSocket chat relay)

## 📌 GitHub Push (after creating remote repo)
```bash
git add .
git commit -m "chore: initialize Arqam-Scale-Suite monorepo scaffold"
git branch -M main
git remote add origin https://github.com/arqamxscales/Arqam-Scale-Suite.git
git push -u origin main
```
