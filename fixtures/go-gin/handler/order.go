package handler

import (
	"net/http"
	"strconv"

	"example.com/shop-api/model"
	"example.com/shop-api/service"
	"github.com/gin-gonic/gin"
)

type OrderHandler struct {
	svc *service.OrderService
}

func NewOrderHandler(s *service.OrderService) *OrderHandler {
	return &OrderHandler{svc: s}
}

// ListOrders 주문 목록 API
func (h *OrderHandler) ListOrders(c *gin.Context) {
	orders, _ := h.svc.List()
	c.JSON(http.StatusOK, orders)
}

func (h *OrderHandler) GetOrder(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	o, _ := h.svc.Get(uint(id))
	c.JSON(http.StatusOK, o)
}

func (h *OrderHandler) CreateOrder(c *gin.Context) {
	var o model.Order
	_ = c.ShouldBindJSON(&o)
	_ = h.svc.Create(&o)
	c.JSON(http.StatusCreated, o)
}

func (h *OrderHandler) DeleteOrder(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	_ = h.svc.Delete(uint(id))
	c.Status(http.StatusNoContent)
}

// OrderPage 주문 관리 화면
func (h *OrderHandler) OrderPage(c *gin.Context) {
	orders, _ := h.svc.List()
	c.HTML(http.StatusOK, "orders/list.html", gin.H{"orders": orders})
}
