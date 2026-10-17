package main

import (
	"html/template"
	"log"
	"net/http"

	"example.com/member-admin/internal/api"
	"example.com/member-admin/internal/member"
	"example.com/member-admin/internal/order"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	_ "github.com/go-sql-driver/mysql"
	"github.com/jmoiron/sqlx"
)

func main() {
	db := sqlx.MustConnect("mysql", "app:pass@tcp(db:3306)/members")
	tmpl := template.Must(template.ParseGlob("web/templates/*.html"))

	memberSvc := member.NewService(member.NewMySQLRepository(db))
	h := member.NewHandler(memberSvc, tmpl)
	orderSvc := order.NewService(order.NewRepository(db))

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Get("/", h.Home)
	r.Route("/members", func(r chi.Router) {
		r.Get("/", h.List)
		r.Post("/", h.Create)
		r.Route("/{id:[0-9]+}", func(r chi.Router) {
			r.Get("/", h.Detail)
			r.Put("/", h.Update)
		})
	})
	r.Mount("/admin", adminRouter(h))
	api.Register(r, orderSvc)
	log.Fatal(http.ListenAndServe(":8080", r))
}

func adminRouter(h *member.Handler) http.Handler {
	r := chi.NewRouter()
	r.Get("/members/stats", h.Stats)
	return r
}
