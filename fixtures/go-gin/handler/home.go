package handler

import "github.com/gin-gonic/gin"

func Home(c *gin.Context) {
	c.HTML(200, "home.html", nil)
}
