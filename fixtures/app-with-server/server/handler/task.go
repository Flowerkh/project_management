package handler

import (
	"net/http"
	"strconv"

	"example.com/fieldsvc/repository"
	"github.com/gin-gonic/gin"
)

type TaskHandler struct {
	repo *repository.TaskRepository
}

func NewTaskHandler(r *repository.TaskRepository) *TaskHandler {
	return &TaskHandler{repo: r}
}

// ListTasks 작업 목록
func (h *TaskHandler) ListTasks(c *gin.Context) {
	tasks, _ := h.repo.FindAll()
	c.JSON(http.StatusOK, tasks)
}

func (h *TaskHandler) GetTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	t, _ := h.repo.FindByID(id)
	c.JSON(http.StatusOK, t)
}

func (h *TaskHandler) CreateTask(c *gin.Context) {
	var body struct{ Title string }
	c.BindJSON(&body)
	h.repo.Insert(body.Title)
	c.Status(http.StatusCreated)
}

func (h *TaskHandler) CompleteTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	h.repo.Complete(id)
	c.Status(http.StatusNoContent)
}
