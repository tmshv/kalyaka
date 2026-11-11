package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCleanName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Quiet Otter", "Quiet Otter"},
		{"  spaced   out  name ", "spaced out name"},
		{"tab\tglued", "tabglued"},
		{"bell\x07ring", "bellring"},
		{"zero\u200bwidth", "zerowidth"},
		{"", "anonymous"},
		{" \n\t ", "anonymous"},
		{strings.Repeat("я", 40), strings.Repeat("я", maxNameRunes)},
	}
	for _, c := range cases {
		if got := cleanName(c.in); got != c.want {
			t.Errorf("cleanName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRoomPattern(t *testing.T) {
	good := []string{"room:a", "room:quiet-otter-42", "room:" + strings.Repeat("a", 40)}
	bad := []string{"a", "room:", "room:-a", "room:Abc", "room:a_b", "room:" + strings.Repeat("a", 41), "other:a"}
	for _, s := range good {
		if !roomRe.MatchString(s) {
			t.Errorf("%q should be a valid room", s)
		}
	}
	for _, s := range bad {
		if roomRe.MatchString(s) {
			t.Errorf("%q should not be a valid room", s)
		}
	}
}

func TestColorPattern(t *testing.T) {
	if !colorRe.MatchString("#2b4fb8") {
		t.Error("#2b4fb8 should be valid")
	}
	for _, s := range []string{"#2B4FB8", "2b4fb8", "#2b4fb", "red", "#2b4fb8; x"} {
		if colorRe.MatchString(s) {
			t.Errorf("%q should not be a valid color", s)
		}
	}
}

func TestBoolJSON(t *testing.T) {
	if boolJSON(true) != "true" || boolJSON(false) != "false" {
		t.Error("boolJSON")
	}
}

func TestAdmitCaps(t *testing.T) {
	h := newHub()
	var gotIP string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIP, _ = r.Context().Value(ipKey{}).(string)
		w.WriteHeader(http.StatusOK)
	})
	admit := h.admit(next)

	req := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/connection/websocket", nil)
		r.RemoteAddr = "192.0.2.1:1234"
		rec := httptest.NewRecorder()
		admit.ServeHTTP(rec, r)
		return rec
	}

	if rec := req(); rec.Code != http.StatusOK || gotIP != "192.0.2.1" {
		t.Fatalf("first connection: status %d ip %q", rec.Code, gotIP)
	}

	h.perIP["192.0.2.1"] = maxConnsPerIP
	if rec := req(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("per-IP cap: status %d, want 429", rec.Code)
	}

	h.perIP = map[string]int{}
	h.conns = maxConns
	if rec := req(); rec.Code != http.StatusTooManyRequests {
		t.Errorf("global cap: status %d, want 429", rec.Code)
	}
}

func TestLeaveDropsEmptyRoomAndPendingSyncs(t *testing.T) {
	h := newHub()
	h.rooms["room:a"] = &room{
		members: map[string]*member{"donor": {}, "joiner": {}},
		pending: map[string]pendingSync{"joiner": {donor: "donor"}},
	}

	h.leave("room:a", "donor")
	r := h.rooms["room:a"]
	if r == nil {
		t.Fatal("room dropped while a member is still in it")
	}
	if _, ok := r.pending["joiner"]; ok {
		t.Error("pending sync kept after its donor left")
	}

	h.leave("room:a", "joiner")
	if _, ok := h.rooms["room:a"]; ok {
		t.Error("empty room was not dropped")
	}

	h.leave("room:missing", "x") // must not panic
}

func TestRequestSyncAloneInMissingRoom(t *testing.T) {
	h := newHub()
	if !h.requestSync("room:missing", "x") {
		t.Error("joiner of a missing room should be alone")
	}
	h.rooms["room:a"] = &room{members: map[string]*member{"x": {}}, pending: map[string]pendingSync{}}
	if !h.requestSync("room:a", "x") {
		t.Error("only member should be alone")
	}
}

func TestDeliverSnapshotRefusesUnrequested(t *testing.T) {
	h := newHub()
	h.rooms["room:a"] = &room{
		members: map[string]*member{"donor": {}, "joiner": {}, "other": {}},
		pending: map[string]pendingSync{},
	}
	if h.deliverSnapshot("room:a", "donor", "joiner", nil) {
		t.Error("delivered a snapshot nobody asked for")
	}
	h.rooms["room:a"].pending["joiner"] = pendingSync{donor: "donor"}
	if h.deliverSnapshot("room:a", "other", "joiner", nil) {
		t.Error("delivered a snapshot from a peer that was not asked")
	}
	if h.deliverSnapshot("room:missing", "donor", "joiner", nil) {
		t.Error("delivered into a missing room")
	}
}
