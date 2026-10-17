package order

import "github.com/jmoiron/sqlx"

// Service 주문 업무 (회원 패키지와 같은 이름의 타입: 섞이면 안 됨)
type Service interface {
	List() ([]Order, error)
}

type Order struct {
	ID     int64
	Status string
}

type Repository struct {
	db *sqlx.DB
}

func NewRepository(db *sqlx.DB) *Repository { return &Repository{db: db} }

func (r *Repository) Find() ([]Order, error) {
	var out []Order
	err := r.db.Select(&out, "SELECT id, status FROM orders ORDER BY id DESC")
	return out, err
}

type service struct {
	repo *Repository
}

func NewService(r *Repository) Service { return &service{repo: r} }

func (s *service) List() ([]Order, error) { return s.repo.Find() }
