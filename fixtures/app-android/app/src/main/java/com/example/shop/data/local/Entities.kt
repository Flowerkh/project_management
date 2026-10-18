package com.example.shop.data.local

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "products")
data class ProductEntity(
    @PrimaryKey val id: Long,
    val name: String,
    @ColumnInfo(name = "unit_price") val price: Int,
)

@Entity(tableName = "orders")
data class OrderEntity(
    @PrimaryKey val id: Long,
    @ColumnInfo(name = "product_id") val productId: Long,
    val qty: Int,
    val status: String?,
)

@Entity(tableName = "users")
data class UserEntity(@PrimaryKey val id: Long, val name: String)
