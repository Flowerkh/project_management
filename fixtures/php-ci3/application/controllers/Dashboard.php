<?php
class Dashboard extends CI_Controller
{
    public function index()
    {
        $data['count'] = $this->db->count_all('orders');
        $this->load->view('templates/header');
        $this->load->view('dashboard', $data);
        $this->load->view('templates/footer');
    }
}
