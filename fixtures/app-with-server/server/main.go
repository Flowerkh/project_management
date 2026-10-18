package main

import (
	"database/sql"

	"example.com/fieldsvc/handler"
	"example.com/fieldsvc/repository"
	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
)

func main() {
	db, _ := sql.Open("mysql", "app:pass@tcp(db:3306)/field")
	repo := repository.NewTaskRepository(db)
	h := handler.NewTaskHandler(repo)

	r := gin.Default()
	api := r.Group("/api/v1")
	{
		api.GET("/tasks", h.ListTasks)
		api.GET("/tasks/:id", h.GetTask)
		api.POST("/tasks", h.CreateTask)
		api.PUT("/tasks/:id/complete", h.CompleteTask)
		api.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	}
	r.Run(":8080")
}
