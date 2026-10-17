package repository

import (
	"example.com/shop-api/model"
	"gorm.io/gorm"
)

type OrderRepository struct {
	db *gorm.DB
}

func NewOrderRepository(db *gorm.DB) *OrderRepository { return &OrderRepository{db: db} }

func (r *OrderRepository) FindAll() ([]model.Order, error) {
	var orders []model.Order
	err := r.db.Preload("Items").Order("id desc").Find(&orders).Error
	return orders, err
}

func (r *OrderRepository) FindByID(id uint) (*model.Order, error) {
	var o model.Order
	err := r.db.First(&o, id).Error
	return &o, err
}

func (r *OrderRepository) Create(o *model.Order) error {
	return r.db.Create(o).Error
}

func (r *OrderRepository) Delete(id uint) error {
	if err := r.db.Where("order_id = ?", id).Delete(&model.OrderItem{}).Error; err != nil {
		return err
	}
	return r.db.Delete(&model.Order{}, id).Error
}

func (r *OrderRepository) StatusCounts() ([]map[string]any, error) {
	var out []map[string]any
	err := r.db.Raw("SELECT status, COUNT(*) AS cnt FROM tb_order GROUP BY status").Scan(&out).Error
	return out, err
}
