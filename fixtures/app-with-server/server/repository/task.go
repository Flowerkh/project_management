package repository

import "database/sql"

type TaskRepository struct {
	db *sql.DB
}

func NewTaskRepository(db *sql.DB) *TaskRepository { return &TaskRepository{db: db} }

func (r *TaskRepository) FindAll() ([]map[string]any, error) {
	rows, err := r.db.Query("SELECT id, title, status FROM tb_task ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return nil, nil
}

func (r *TaskRepository) FindByID(id int) (map[string]any, error) {
	row := r.db.QueryRow("SELECT id, title, status FROM tb_task WHERE id = ?", id)
	_ = row
	return nil, nil
}

func (r *TaskRepository) Insert(title string) error {
	_, err := r.db.Exec("INSERT INTO tb_task (title, status) VALUES (?, 'OPEN')", title)
	return err
}

func (r *TaskRepository) Complete(id int) error {
	if _, err := r.db.Exec("UPDATE tb_task SET status = 'DONE' WHERE id = ?", id); err != nil {
		return err
	}
	_, err := r.db.Exec("INSERT INTO tb_task_log (task_id, action) VALUES (?, 'COMPLETE')", id)
	return err
}
