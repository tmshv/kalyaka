package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testMux(t *testing.T) *http.ServeMux {
	t.Helper()
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		t.Fatal(err)
	}
	ws := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	mux, err := newMux(web, ws)
	if err != nil {
		t.Fatal(err)
	}
	return mux
}

func serve(mux http.Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestIndexServedForRooms(t *testing.T) {
	mux := testMux(t)
	for _, target := range []string{"/", "/quiet-otter-42"} {
		rec := serve(mux, http.MethodGet, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d", target, rec.Code)
		}
		body := rec.Body.String()
		if strings.Contains(body, "__V__") {
			t.Errorf("GET %s: asset version placeholder not replaced", target)
		}
		if !strings.Contains(body, "<title>kalyaka</title>") {
			t.Errorf("GET %s: not the index page", target)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("GET %s: Cache-Control %q", target, got)
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("GET %s: missing Content-Security-Policy", target)
		}
	}
}

func TestIndexRejectsNestedPathsAndOtherMethods(t *testing.T) {
	mux := testMux(t)
	if rec := serve(mux, http.MethodGet, "/a/b"); rec.Code != http.StatusNotFound {
		t.Errorf("GET /a/b: status %d, want 404", rec.Code)
	}
	rec := serve(mux, http.MethodPost, "/room")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /room: status %d, want 405", rec.Code)
	}
	if got := rec.Header().Get("Allow"); got != "GET, HEAD" {
		t.Errorf("POST /room: Allow %q", got)
	}
}

func TestStaticAssets(t *testing.T) {
	mux := testMux(t)
	rec := serve(mux, http.MethodGet, "/static/app.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /static/app.js: status %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=604800" {
		t.Errorf("Cache-Control %q", got)
	}
	for _, target := range []string{"/static/index.html", "/static/", "/static/fonts", "/static/missing.js"} {
		if rec := serve(mux, http.MethodGet, target); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: status %d, want 404", target, rec.Code)
		}
	}
}

func TestRobots(t *testing.T) {
	rec := serve(testMux(t), http.MethodGet, "/robots.txt")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Disallow: /") {
		t.Errorf("robots.txt: status %d body %q", rec.Code, rec.Body.String())
	}
}

func TestWebsocketRouted(t *testing.T) {
	if rec := serve(testMux(t), http.MethodGet, "/connection/websocket"); rec.Code != http.StatusTeapot {
		t.Errorf("websocket route: status %d", rec.Code)
	}
}

func TestAssetHashChangesWithContent(t *testing.T) {
	a := fstest.MapFS{"app.js": {Data: []byte("one")}}
	b := fstest.MapFS{"app.js": {Data: []byte("two")}}
	ha, hb := assetHash(a), assetHash(b)
	if len(ha) != 10 {
		t.Errorf("hash length %d, want 10", len(ha))
	}
	if ha == hb {
		t.Error("hash did not change with content")
	}
	if ha != assetHash(a) {
		t.Error("hash is not stable")
	}
}

func TestSameOrigin(t *testing.T) {
	cases := []struct {
		origin, host string
		want         bool
	}{
		{"", "example.com", true},
		{"https://example.com", "example.com", true},
		{"https://EXAMPLE.com", "example.com", true},
		{"https://example.com:8443", "example.com:8443", true},
		{"https://evil.com", "example.com", false},
		{"example.com", "example.com", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/connection/websocket", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if got := sameOrigin(r); got != c.want {
			t.Errorf("origin %q host %q: got %v, want %v", c.origin, c.host, got, c.want)
		}
	}
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		xff, remote, want string
	}{
		{"", "192.0.2.1:5555", "192.0.2.1"},
		{"203.0.113.7", "127.0.0.1:5555", "203.0.113.7"},
		{" 203.0.113.7 , 10.0.0.1", "127.0.0.1:5555", "203.0.113.7"},
		{"", "not-an-addr", "not-an-addr"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = c.remote
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientIP(r); got != c.want {
			t.Errorf("xff %q remote %q: got %q, want %q", c.xff, c.remote, got, c.want)
		}
	}
}
