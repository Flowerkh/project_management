package com.example.shop.ui.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.shop.data.repository.OrderRepository
import kotlinx.coroutines.launch
import javax.inject.Inject

class OrdersViewModel @Inject constructor(private val repo: OrderRepository) : ViewModel() {
    fun refresh() {
        viewModelScope.launch { repo.getOrders() }
    }
}
