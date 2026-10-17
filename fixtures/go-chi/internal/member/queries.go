package member

const queryListMembers = `SELECT m.id, m.name, m.email, g.name AS grade
  FROM members m
  LEFT JOIN member_grades g ON g.id = m.grade_id
 ORDER BY m.id DESC`
