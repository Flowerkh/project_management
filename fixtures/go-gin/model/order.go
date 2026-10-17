package model

import "time"

type Order struct {
	ID        uint `gorm:"primaryKey"`
	Status    string
	Items     []OrderItem
	CreatedAt time.Time
}

func (Order) TableName() string { return "tb_order" }

type OrderItem struct {
	ID      uint
	OrderID uint
	Qty     int
}
