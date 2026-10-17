package main

import (
	"database/sql"
	"html/template"
	"log"
	"net/http"

	_ "github.com/go-sql-driver/mysql"
)

var (
	db   *sql.DB
	tmpl = template.Must(template.ParseGlob("templates/*.gohtml"))
)

func main() {
	var err error
	db, err = sql.Open("mysql", "app:pass@tcp(db:3306)/board")
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/posts", listPosts)
	mux.HandleFunc("/posts/view", viewPost)
	mux.HandleFunc("POST /posts/save", savePost)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	log.Fatal(http.ListenAndServe(":8080", mux))
}
