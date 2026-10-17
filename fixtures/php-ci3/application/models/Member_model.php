<?php
class Member_model extends CI_Model
{
    public function get_member($id)
    {
        return $this->db->query("SELECT * FROM members WHERE id = ?", array($id))->row();
    }
}
