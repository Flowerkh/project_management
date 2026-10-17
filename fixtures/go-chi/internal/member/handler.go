package member

import (
	"html/template"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type Handler struct {
	svc  Service
	tmpl *template.Template
}

func NewHandler(svc Service, tmpl *template.Template) *Handler { return &Handler{svc: svc, tmpl: tmpl} }

func (h *Handler) render(w http.ResponseWriter, name string, data any) {
	if err := h.tmpl.ExecuteTemplate(w, name+".html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// Home 첫 화면
func (h *Handler) Home(w http.ResponseWriter, r *http.Request) {
	h.render(w, "home", nil)
}

// List 회원 목록
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	members, _ := h.svc.List(r.Context())
	h.render(w, "member_list", members)
}

func (h *Handler) Detail(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	m, _ := h.svc.Get(r.Context(), id)
	h.render(w, "member_detail", m)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	m := &Member{Name: r.FormValue("name"), Email: r.FormValue("email")}
	_ = h.svc.Save(r.Context(), m)
	http.Redirect(w, r, "/members", http.StatusSeeOther)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	_ = h.svc.Save(r.Context(), &Member{ID: id, Name: r.FormValue("name")})
	w.WriteHeader(http.StatusNoContent)
}

// Stats 관리자 회원 통계
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	n, _ := h.svc.Stats(r.Context())
	w.Write([]byte(strconv.Itoa(n)))
}
