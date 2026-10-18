package com.example.shop.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface UserDao {
    @Insert
    suspend fun save(user: UserEntity)

    @Query("DELETE FROM users")
    suspend fun clear()
}
