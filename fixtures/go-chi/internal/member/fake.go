package member

import "context"

// 개발용 가짜 저장소 (구현체 후보에서 빠져야 함)
type fakeRepository struct{}

func (fakeRepository) FindAll(ctx context.Context) ([]Member, error)            { return nil, nil }
func (fakeRepository) FindByID(ctx context.Context, id int64) (*Member, error)  { return nil, nil }
func (fakeRepository) Insert(ctx context.Context, m *Member) error              { return nil }
func (fakeRepository) Update(ctx context.Context, m *Member) error              { return nil }
func (fakeRepository) WriteLog(ctx context.Context, id int64, a string) error   { return nil }
func (fakeRepository) Count(ctx context.Context) (int, error)                   { return 0, nil }
