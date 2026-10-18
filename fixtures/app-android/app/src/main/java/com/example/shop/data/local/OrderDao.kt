package com.example.shop.data.local

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.Query

@Dao
interface OrderDao {
    @Query("SELECT * FROM orders ORDER BY id DESC")
    suspend fun getAll(): List<OrderEntity>

    @Insert
    suspend fun insertAll(items: List<OrderEntity>)

    @Delete
    suspend fun delete(item: OrderEntity)
}
