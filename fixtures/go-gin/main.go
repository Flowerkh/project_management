package main

import (
	"example.com/shop-api/handler"
	"example.com/shop-api/repository"
	"example.com/shop-api/service"
	"github.com/gin-gonic/gin"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
)

func main() {
	db, _ := gorm.Open(mysql.Open("app:pass@tcp(db:3306)/shop"), &gorm.Config{})
	repo := repository.NewOrderRepository(db)
	svc := service.NewOrderService(repo)
	h := handler.NewOrderHandler(svc)

	r := gin.Default()
	r.LoadHTMLGlob("templates/**/*")
	r.GET("/", handler.Home)

	api := r.Group("/api")
	{
		v1 := api.Group("/v1")
		v1.GET("/orders", h.ListOrders)
		v1.GET("/orders/:id", h.GetOrder)
		v1.POST("/orders", h.CreateOrder)
		v1.DELETE("/orders/:id", h.DeleteOrder)
		v1.GET("/stats", func(c *gin.Context) {
			var n int64
			db.Table("tb_order").Count(&n)
			c.JSON(200, gin.H{"count": n})
		})
	}
	admin := r.Group("/admin")
	admin.GET("/orders", h.OrderPage)
	r.Run(":8080")
}
