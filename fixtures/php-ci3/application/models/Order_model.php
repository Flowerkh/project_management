<?php
class Order_model extends CI_Model
{
    public function get_list()
    {
        $this->db->select('o.*, m.name');
        $this->db->from('orders o');
        $this->db->join('members m', 'm.id = o.member_id');
        return $this->db->get()->result();
    }

    public function get($id)
    {
        return $this->db->get_where('orders', array('id' => $id))->row();
    }

    public function update_status($id, $status)
    {
        $this->db->where('id', $id);
        $this->db->update('orders', array('status' => $status));
    }

    public function add_history($id)
    {
        $this->db->insert('order_history', array('order_id' => $id));
    }
}
