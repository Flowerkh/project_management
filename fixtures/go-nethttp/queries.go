package main

const queryListPosts = `
SELECT p.id, p.title, u.name
  FROM posts p
  JOIN users u ON p.user_id = u.id
 ORDER BY p.id DESC`
