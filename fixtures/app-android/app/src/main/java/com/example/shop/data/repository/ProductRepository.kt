package com.example.shop.data.repository

import com.example.shop.data.local.ProductDao
import com.example.shop.data.local.ProductEntity
import com.example.shop.data.remote.ShopApi
import javax.inject.Inject

class ProductRepository @Inject constructor(
    private val api: ShopApi,
    private val dao: ProductDao,
) {
    suspend fun getProducts(): List<ProductEntity> {
        val remote = api.getProducts()
        dao.insertAll(remote.map { ProductEntity(it.id, it.name, it.price) })
        return dao.getAll()
    }

    suspend fun getProduct(id: Long): ProductEntity =
        dao.findById(id) ?: api.getProduct(id).let { ProductEntity(it.id, it.name, it.price) }
}
