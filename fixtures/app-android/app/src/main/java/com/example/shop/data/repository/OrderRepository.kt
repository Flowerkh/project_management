package com.example.shop.data.repository

import com.example.shop.data.local.AppDatabase
import com.example.shop.data.local.OrderEntity
import com.example.shop.data.remote.OrderRequest
import com.example.shop.data.remote.ShopApi
import javax.inject.Inject

interface OrderRepository {
    suspend fun getOrders(): List<OrderEntity>
    suspend fun placeOrder(req: OrderRequest)
}

class OrderRepositoryImpl @Inject constructor(
    private val api: ShopApi,
    private val db: AppDatabase,
) : OrderRepository {
    private val dao = db.orderDao()

    override suspend fun getOrders(): List<OrderEntity> {
        val remote = api.getOrders()
        dao.insertAll(remote.map { OrderEntity(it.id, it.productId, it.qty, it.status) })
        return dao.getAll()
    }

    override suspend fun placeOrder(req: OrderRequest) {
        api.createOrder(req)
    }
}
