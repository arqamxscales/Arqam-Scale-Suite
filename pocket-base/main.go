package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

type App struct {
	db          *sql.DB
	jwtSecret   []byte
	subscribers map[chan string]struct{}
	mu          sync.RWMutex
}

type Claims struct {
	UserID int64 `json:"user_id"`
	jwt.RegisteredClaims
}

type contextKey string

const userIDKey contextKey = "userID"

func main() {
	dataDir := getEnv("PB_DATA_DIR", "./pb_data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("failed to create data dir: %v", err)
	}

	dbPath := dataDir + "/app.db"
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("failed to open sqlite db: %v", err)
	}
	defer db.Close()

	if err := runMigrations(db); err != nil {
		log.Fatalf("migration failed: %v", err)
	}

	app := &App{
		db:          db,
		jwtSecret:   []byte(getEnv("JWT_SECRET", "change-me")),
		subscribers: map[chan string]struct{}{},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", app.health)
	mux.HandleFunc("POST /auth/register", app.register)
	mux.HandleFunc("POST /auth/login", app.login)
	mux.Handle("GET /api/notes", app.authMiddleware(http.HandlerFunc(app.listNotes)))
	mux.Handle("POST /api/notes", app.authMiddleware(http.HandlerFunc(app.createNote)))
	mux.Handle("GET /api/subscribe", app.authMiddleware(http.HandlerFunc(app.subscribe)))

	handler := withCORS(mux)
	addr := ":8080"
	log.Printf("pocket-base started on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}

func runMigrations(db *sql.DB) error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS notes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			content TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY(user_id) REFERENCES users(id)
		);`,
	}
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "email required and password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to secure password")
		return
	}

	_, err = a.db.Exec(`INSERT INTO users (email, password_hash) VALUES (?, ?)`, req.Email, string(hash))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, http.StatusConflict, "email already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"message": "user created"})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	var userID int64
	var hash string
	err := a.db.QueryRow(`SELECT id, password_hash FROM users WHERE email = ?`, req.Email).Scan(&userID, &hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := a.issueToken(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue token")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":   token,
		"user_id": userID,
	})
}

func (a *App) listNotes(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(int64)

	rows, err := a.db.Query(`SELECT id, content, created_at FROM notes WHERE user_id = ? ORDER BY id DESC`, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch notes")
		return
	}
	defer rows.Close()

	type note struct {
		ID        int64  `json:"id"`
		Content   string `json:"content"`
		CreatedAt string `json:"created_at"`
	}
	var notes []note
	for rows.Next() {
		var n note
		if err := rows.Scan(&n.ID, &n.Content, &n.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read note")
			return
		}
		notes = append(notes, n)
	}

	writeJSON(w, http.StatusOK, map[string]any{"items": notes})
}

func (a *App) createNote(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userIDKey).(int64)

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	res, err := a.db.Exec(`INSERT INTO notes (user_id, content) VALUES (?, ?)`, userID, req.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create note")
		return
	}

	noteID, _ := res.LastInsertId()
	event := fmt.Sprintf(`{"type":"note.created","id":%d,"user_id":%d}`, noteID, userID)
	a.broadcast(event)

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":      noteID,
		"content": req.Content,
	})
}

func (a *App) subscribe(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	ch := make(chan string, 16)
	a.addSubscriber(ch)
	defer a.removeSubscriber(ch)

	fmt.Fprint(w, "event: ready\n")
	fmt.Fprint(w, "data: {\"status\":\"subscribed\"}\n\n")
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "event: message\n")
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		}
	}
}

func (a *App) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
		if authHeader == "" || !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}

		tokenStr := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer"))
		tokenStr = strings.TrimSpace(strings.TrimPrefix(tokenStr, "bearer"))
		claims := &Claims{}
		token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (any, error) {
			return a.jwtSecret, nil
		})
		if err != nil || !token.Valid {
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}

		ctx := r.Context()
		ctx = context.WithValue(ctx, userIDKey, claims.UserID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *App) issueToken(userID int64) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
			Subject:   strconv.FormatInt(userID, 10),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(a.jwtSecret)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) addSubscriber(ch chan string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.subscribers[ch] = struct{}{}
}

func (a *App) removeSubscriber(ch chan string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.subscribers, ch)
	close(ch)
}

func (a *App) broadcast(message string) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for ch := range a.subscribers {
		select {
		case ch <- message:
		default:
		}
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func getEnv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
