package member

import (
	"context"

	"github.com/jmoiron/sqlx"
)

type Repository interface {
	FindAll(ctx context.Context) ([]Member, error)
	FindByID(ctx context.Context, id int64) (*Member, error)
	Insert(ctx context.Context, m *Member) error
	Update(ctx context.Context, m *Member) error
	WriteLog(ctx context.Context, id int64, action string) error
	Count(ctx context.Context) (int, error)
}

type mysqlRepository struct {
	db *sqlx.DB
}

func NewMySQLRepository(db *sqlx.DB) Repository { return &mysqlRepository{db: db} }

func (r *mysqlRepository) FindAll(ctx context.Context) ([]Member, error) {
	var out []Member
	err := r.db.SelectContext(ctx, &out, queryListMembers)
	return out, err
}

func (r *mysqlRepository) FindByID(ctx context.Context, id int64) (*Member, error) {
	var m Member
	err := r.db.GetContext(ctx, &m, "SELECT id, name, email FROM members WHERE id = ?", id)
	return &m, err
}

func (r *mysqlRepository) Insert(ctx context.Context, m *Member) error {
	_, err := r.db.NamedExecContext(ctx, "INSERT INTO members (name, email) VALUES (:name, :email)", m)
	return err
}

func (r *mysqlRepository) Update(ctx context.Context, m *Member) error {
	_, err := r.db.ExecContext(ctx, `UPDATE members SET name = ?, email = ? WHERE id = ?`, m.Name, m.Email, m.ID)
	return err
}

func (r *mysqlRepository) WriteLog(ctx context.Context, id int64, action string) error {
	_, err := r.db.ExecContext(ctx, "INSERT INTO member_logs (member_id, action) VALUES (?, ?)", id, action)
	return err
}

func (r *mysqlRepository) Count(ctx context.Context) (int, error) {
	var n int
	err := r.db.GetContext(ctx, &n, "SELECT COUNT(*) FROM members")
	return n, err
}
