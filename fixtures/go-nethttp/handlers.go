package main

import "net/http"

// listPosts 게시글 목록
func listPosts(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(queryListPosts)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer rows.Close()
	tmpl.ExecuteTemplate(w, "list.gohtml", rows)
}

func viewPost(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	row := db.QueryRow("SELECT id, title, body FROM posts WHERE id = ?", id)
	comments, _ := db.Query(`SELECT c.id, c.body FROM comments c WHERE c.post_id = ?`, id)
	_ = comments
	tmpl.ExecuteTemplate(w, "view.gohtml", row)
}

func savePost(w http.ResponseWriter, r *http.Request) {
	res, _ := db.Exec("INSERT INTO posts (title, body, user_id) VALUES (?, ?, ?)", r.FormValue("title"), r.FormValue("body"), 1)
	_ = res
	db.Exec(`UPDATE boards SET post_count = post_count + 1 WHERE id = ?`, r.FormValue("board"))
	http.Redirect(w, r, "/posts", http.StatusSeeOther)
}
