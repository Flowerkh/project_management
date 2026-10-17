package member

import "context"

// Service 회원 업무
type Service interface {
	List(ctx context.Context) ([]Member, error)
	Get(ctx context.Context, id int64) (*Member, error)
	Save(ctx context.Context, m *Member) error
	Stats(ctx context.Context) (int, error)
}

type service struct {
	repo Repository
}

func NewService(r Repository) Service { return &service{repo: r} }

func (s *service) List(ctx context.Context) ([]Member, error) { return s.repo.FindAll(ctx) }

func (s *service) Get(ctx context.Context, id int64) (*Member, error) { return s.repo.FindByID(ctx, id) }

func (s *service) Save(ctx context.Context, m *Member) error {
	if m.ID == 0 {
		return s.repo.Insert(ctx, m)
	}
	if err := s.repo.Update(ctx, m); err != nil {
		return err
	}
	return s.repo.WriteLog(ctx, m.ID, "update")
}

func (s *service) Stats(ctx context.Context) (int, error) { return s.repo.Count(ctx) }
