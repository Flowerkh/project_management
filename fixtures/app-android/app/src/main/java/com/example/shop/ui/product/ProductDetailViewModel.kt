package com.example.shop.ui.product

import androidx.lifecycle.ViewModel
import androidx.lifecycle.liveData
import androidx.lifecycle.viewModelScope
import com.example.shop.data.remote.OrderRequest
import com.example.shop.data.repository.OrderRepository
import com.example.shop.data.repository.ProductRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ProductDetailViewModel @Inject constructor(
    private val products: ProductRepository,
    private val orders: OrderRepository,
) : ViewModel() {

    fun product(id: Long) = liveData { emit(products.getProduct(id)) }

    fun placeOrder(productId: Long, qty: Int) {
        viewModelScope.launch { orders.placeOrder(OrderRequest(productId, qty)) }
    }
}
