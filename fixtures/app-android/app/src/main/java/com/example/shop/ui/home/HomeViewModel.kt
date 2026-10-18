package com.example.shop.ui.home

import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.shop.data.local.ProductEntity
import com.example.shop.data.repository.ProductRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: ProductRepository,
) : ViewModel() {

    val products = MutableLiveData<List<ProductEntity>>()

    fun load() {
        viewModelScope.launch {
            products.value = repository.getProducts()
        }
    }
}
