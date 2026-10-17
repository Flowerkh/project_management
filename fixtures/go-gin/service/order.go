package service

import (
	"example.com/shop-api/model"
	"example.com/shop-api/repository"
)

type OrderService struct {
	repo *repository.OrderRepository
}

func NewOrderService(r *repository.OrderRepository) *OrderService {
	return &OrderService{repo: r}
}

func (s *OrderService) List() ([]model.Order, error) { return s.repo.FindAll() }

func (s *OrderService) Get(id uint) (*model.Order, error) { return s.repo.FindByID(id) }

func (s *OrderService) Create(o *model.Order) error { return s.repo.Create(o) }

func (s *OrderService) Delete(id uint) error { return s.repo.Delete(id) }
