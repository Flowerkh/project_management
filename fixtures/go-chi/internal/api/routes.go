package api

import (
	"encoding/json"
	"net/http"

	"example.com/member-admin/internal/order"
	"github.com/go-chi/chi/v5"
)

// Register API 라우트
func Register(r chi.Router, svc order.Service) {
	r.Route("/api", func(r chi.Router) {
		r.Get("/orders", listOrders(svc))
	})
}

func listOrders(svc order.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		orders, _ := svc.List()
		json.NewEncoder(w).Encode(orders)
	}
}
