// Command draw serves kalyaka: a shared drawing sheet where everyone in a room
// draws on the same page in real time. Nothing is stored. The server only
// relays messages between the people in a room, and a room exists only while
// someone is in it.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/centrifugal/centrifuge"
)

//go:embed web
var webFS embed.FS

func main() {
	listen := flag.String("listen", "127.0.0.1:20480", "address to serve HTTP on")
	flag.Parse()

	node, err := centrifuge.New(centrifuge.Config{
		LogLevel:           centrifuge.LogLevelError,
		LogHandler:         func(e centrifuge.LogEntry) { log.Printf("%s %v", e.Message, e.Fields) },
		ClientChannelLimit: 1,
		ChannelMaxLength:   64,
		// Bounds a slow reader's outgoing queue; past it the client is dropped.
		ClientQueueMaxSize: 4 << 20,
	})
	if err != nil {
		log.Fatal(err)
	}
	hub := newHub()
	hub.attach(node)
	if err := node.Run(); err != nil {
		log.Fatal(err)
	}

	ws := centrifuge.NewWebsocketHandler(node, centrifuge.WebsocketConfig{
		// A snapshot for a late joiner is the largest frame a client sends.
		MessageSizeLimit: maxSnapshot + 4096,
		ReadBufferSize:   4096,
		WriteBufferSize:  4096,
		// Caddy checks the host; the origin must be the page itself.
		CheckOrigin: sameOrigin,
	})

	web, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()
	mux.Handle("/connection/websocket", hub.admit(ws))
	mux.Handle("/static/", http.StripPrefix("/static/", static(web)))
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		// Rooms are private links; only the front page is for indexing.
		_, _ = w.Write([]byte("User-agent: *\nAllow: /$\nDisallow: /\n"))
	})
	index, err := fs.ReadFile(web, "index.html")
	if err != nil {
		log.Fatal(err)
	}
	// Asset URLs carry a hash of the assets, so a deploy reaches every
	// browser at once while the files themselves cache for long.
	index = bytes.ReplaceAll(index, []byte("__V__"), []byte(version(web)))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Every single-segment path is a room; the page reads it from the URL.
		if strings.Count(r.URL.Path, "/") > 1 {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; frame-ancestors 'none'")
		_, _ = w.Write(index)
	})

	srv := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		log.Printf("listening on %s", *listen)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = node.Shutdown(ctx)
	_ = srv.Shutdown(ctx)
}

// static serves the embedded assets. The page links them with ?v=<hash>.
func static(web fs.FS) http.Handler {
	files := http.FileServerFS(web)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if path.Ext(r.URL.Path) == "" || r.URL.Path == "index.html" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=604800")
		files.ServeHTTP(w, r)
	})
}

func version(web fs.FS) string {
	h := sha256.New()
	_ = fs.WalkDir(web, ".", func(name string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(web, name)
			h.Write([]byte(name))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:10]
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	_, host, ok := strings.Cut(origin, "://")
	return ok && strings.EqualFold(host, r.Host)
}

// clientIP is the visitor's address. Caddy, the only thing in front of this
// server, replaces X-Forwarded-For with the address it sees.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
