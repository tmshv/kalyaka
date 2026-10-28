package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/centrifugal/centrifuge"
	"golang.org/x/time/rate"
)

// Hard caps that bound the server's memory. A room lives only in these maps
// and in centrifuge's channel registry, and both drop it with its last member.
const (
	maxConns      = 1000
	maxConnsPerIP = 8
	maxRooms      = 200
	maxPerRoom    = 16

	// One message carries a few frames' worth of points and the cursor.
	maxPublish = 16 << 10
	// A late joiner gets the whole page from a peer in one message.
	maxSnapshot = 1 << 20

	// Clients batch everything into one message per animation tick (~25/s).
	publishRate  = 30
	publishBurst = 60
	// Messages over the limit are refused; this many refusals drop the client.
	maxStrikes = 100

	// How long a peer has to answer a late joiner with a snapshot.
	syncTTL = 10 * time.Second

	maxNameRunes = 32
)

var (
	roomRe  = regexp.MustCompile(`^room:[a-z0-9][a-z0-9-]{0,39}$`)
	colorRe = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

type hub struct {
	mu    sync.Mutex
	conns int
	perIP map[string]int
	rooms map[string]*room
}

type room struct {
	seq     uint64
	members map[string]*member
	// Late joiners waiting for a snapshot, keyed by joiner, valued by the
	// peer asked to send it.
	pending map[string]pendingSync
}

type member struct {
	client *centrifuge.Client
	joined uint64
}

type pendingSync struct {
	donor string
	until time.Time
}

func newHub() *hub {
	return &hub{perIP: map[string]int{}, rooms: map[string]*room{}}
}

type ipKey struct{}

// admit refuses a WebSocket over the connection caps before the upgrade and
// records the visitor's address for the handlers.
func (h *hub) admit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		h.mu.Lock()
		full := h.conns >= maxConns || h.perIP[ip] >= maxConnsPerIP
		h.mu.Unlock()
		if full {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ipKey{}, ip)))
	})
}

type profile struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (h *hub) attach(node *centrifuge.Node) {
	node.OnConnecting(func(ctx context.Context, e centrifuge.ConnectEvent) (centrifuge.ConnectReply, error) {
		var p profile
		_ = json.Unmarshal(e.Data, &p)
		p.Name = cleanName(p.Name)
		if !colorRe.MatchString(p.Color) {
			p.Color = "#2b4fb8"
		}
		info, _ := json.Marshal(p)
		// Anonymous: an empty UserID. The connection info carries the name
		// to everyone in the room on join.
		return centrifuge.ConnectReply{Credentials: &centrifuge.Credentials{Info: info}}, nil
	})

	node.OnConnect(func(c *centrifuge.Client) {
		ip, _ := c.Context().Value(ipKey{}).(string)
		h.mu.Lock()
		h.conns++
		h.perIP[ip]++
		h.mu.Unlock()

		limiter := rate.NewLimiter(publishRate, publishBurst)
		var strikes atomic.Int32
		allow := func() error {
			if limiter.Allow() {
				return nil
			}
			if strikes.Add(1) > maxStrikes {
				return centrifuge.DisconnectTooManyRequests
			}
			return centrifuge.ErrorLimitExceeded
		}
		var channel atomic.Value // string: the room this client is in

		c.OnSubscribe(func(e centrifuge.SubscribeEvent, cb centrifuge.SubscribeCallback) {
			if !roomRe.MatchString(e.Channel) {
				cb(centrifuge.SubscribeReply{}, centrifuge.ErrorPermissionDenied)
				return
			}
			if err := h.join(e.Channel, c); err != nil {
				cb(centrifuge.SubscribeReply{}, err)
				return
			}
			channel.Store(e.Channel)
			cb(centrifuge.SubscribeReply{Options: centrifuge.SubscribeOptions{
				EmitJoinLeave: true,
				PushJoinLeave: true,
			}}, nil)
		})

		c.OnUnsubscribe(func(e centrifuge.UnsubscribeEvent) {
			h.leave(e.Channel, c.ID())
		})

		c.OnPublish(func(e centrifuge.PublishEvent, cb centrifuge.PublishCallback) {
			if ch, _ := channel.Load().(string); e.Channel != ch {
				cb(centrifuge.PublishReply{}, centrifuge.ErrorPermissionDenied)
				return
			}
			if len(e.Data) > maxPublish {
				cb(centrifuge.PublishReply{}, centrifuge.ErrorLimitExceeded)
				return
			}
			if err := allow(); err != nil {
				cb(centrifuge.PublishReply{}, err)
				return
			}
			// No history: a publication exists only on the wire. Peers tell
			// senders apart by client ID; names travel in join events.
			cb(centrifuge.PublishReply{Options: centrifuge.PublishOptions{
				ClientInfo: &centrifuge.ClientInfo{ClientID: e.ClientInfo.ClientID},
			}}, nil)
		})

		c.OnRPC(func(e centrifuge.RPCEvent, cb centrifuge.RPCCallback) {
			if err := allow(); err != nil {
				cb(centrifuge.RPCReply{}, err)
				return
			}
			ch, _ := channel.Load().(string)
			if ch == "" {
				cb(centrifuge.RPCReply{}, centrifuge.ErrorBadRequest)
				return
			}
			switch e.Method {
			case "sync":
				alone := h.requestSync(ch, c.ID())
				cb(centrifuge.RPCReply{Data: []byte(`{"alone":` + boolJSON(alone) + `}`)}, nil)
			case "snap":
				if len(e.Data) > maxSnapshot {
					cb(centrifuge.RPCReply{}, centrifuge.ErrorLimitExceeded)
					return
				}
				var s struct {
					To string `json:"to"`
				}
				if err := json.Unmarshal(e.Data, &s); err != nil || s.To == "" {
					cb(centrifuge.RPCReply{}, centrifuge.ErrorBadRequest)
					return
				}
				if !h.deliverSnapshot(ch, c.ID(), s.To, e.Data) {
					cb(centrifuge.RPCReply{}, centrifuge.ErrorPermissionDenied)
					return
				}
				cb(centrifuge.RPCReply{Data: []byte(`{}`)}, nil)
			default:
				cb(centrifuge.RPCReply{}, centrifuge.ErrorMethodNotFound)
			}
		})

		c.OnDisconnect(func(e centrifuge.DisconnectEvent) {
			if ch, _ := channel.Load().(string); ch != "" {
				h.leave(ch, c.ID())
			}
			h.mu.Lock()
			h.conns--
			if h.perIP[ip]--; h.perIP[ip] <= 0 {
				delete(h.perIP, ip)
			}
			h.mu.Unlock()
		})
	})
}

func (h *hub) join(channel string, c *centrifuge.Client) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[channel]
	if r == nil {
		if len(h.rooms) >= maxRooms {
			return centrifuge.ErrorLimitExceeded
		}
		r = &room{members: map[string]*member{}, pending: map[string]pendingSync{}}
		h.rooms[channel] = r
	}
	if len(r.members) >= maxPerRoom {
		return centrifuge.ErrorLimitExceeded
	}
	r.seq++
	r.members[c.ID()] = &member{client: c, joined: r.seq}
	return nil
}

func (h *hub) leave(channel, id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[channel]
	if r == nil {
		return
	}
	delete(r.members, id)
	delete(r.pending, id)
	for target, p := range r.pending {
		if p.donor == id {
			delete(r.pending, target)
		}
	}
	if len(r.members) == 0 {
		delete(h.rooms, channel)
	}
}

// requestSync asks the longest-present peer to send the joiner the page.
// It reports whether the joiner is alone, so there is nothing to wait for.
func (h *hub) requestSync(channel, joiner string) bool {
	h.mu.Lock()
	r := h.rooms[channel]
	if r == nil {
		h.mu.Unlock()
		return true
	}
	var donor *member
	for id, m := range r.members {
		if id != joiner && (donor == nil || m.joined < donor.joined) {
			donor = m
		}
	}
	if donor == nil {
		h.mu.Unlock()
		return true
	}
	r.pending[joiner] = pendingSync{donor: donor.client.ID(), until: time.Now().Add(syncTTL)}
	h.mu.Unlock()
	_ = donor.client.Send([]byte(`{"t":"sync","to":"` + joiner + `"}`))
	return false
}

// deliverSnapshot forwards a snapshot only from the peer that was asked for
// it, once, so no client can push large messages at others unprompted.
func (h *hub) deliverSnapshot(channel, donor, joiner string, data []byte) bool {
	h.mu.Lock()
	r := h.rooms[channel]
	if r == nil {
		h.mu.Unlock()
		return false
	}
	p, ok := r.pending[joiner]
	m := r.members[joiner]
	if !ok || p.donor != donor || time.Now().After(p.until) || m == nil {
		h.mu.Unlock()
		return false
	}
	delete(r.pending, joiner)
	h.mu.Unlock()
	_ = m.client.Send(data)
	return true
}

func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > maxNameRunes {
		s = string(r[:maxNameRunes])
	}
	if s == "" {
		s = "anonymous"
	}
	return s
}

func boolJSON(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
