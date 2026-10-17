<?php
defined('BASEPATH') OR exit('No direct script access allowed');

class Order extends CI_Controller
{
    public function __construct()
    {
        parent::__construct();
        $this->load->model('order_model');
    }

    public function index()
    {
        $data['orders'] = $this->order_model->get_list();
        $this->load->view('templates/header');
        $this->load->view('order/list', $data);
        $this->load->view('templates/footer');
    }

    public function detail($id)
    {
        $data['order'] = $this->order_model->get($id);
        $this->load->model('Member_model', 'member');
        $data['member'] = $this->member->get_member($data['order']->member_id);
        $this->load->view('templates/header');
        $this->load->view('order/detail', $data);
        $this->load->view('templates/footer');
    }

    public function update_status()
    {
        $id = $this->input->post('id');
        $this->order_model->update_status($id, $this->input->post('status'));
        $this->order_model->add_history($id);
        redirect('order/detail/' . $id);
    }

    private function _check() {}
}
