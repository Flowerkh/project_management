package com.example.shop.data.repository

import com.example.shop.data.local.UserDao
import com.example.shop.data.local.UserEntity
import com.example.shop.data.remote.ShopApi
import javax.inject.Inject

class UserRepository @Inject constructor(private val api: ShopApi, private val userDao: UserDao) {
    suspend fun loadMe() {
        val me = api.getMe()
        userDao.save(UserEntity(me.id, me.name))
    }

    suspend fun logout() = userDao.clear()
}
