package com.example.shop.data.remote

data class ProductDto(val id: Long, val name: String, val price: Int)
data class OrderDto(val id: Long, val productId: Long, val qty: Int, val status: String)
data class OrderRequest(val productId: Long, val qty: Int)
data class UserDto(val id: Long, val name: String)
