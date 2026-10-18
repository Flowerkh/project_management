package com.example.shop.di

import com.example.shop.BuildConfig
import com.example.shop.data.remote.ShopApi
import dagger.Module
import dagger.Provides
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

@Module
object NetworkModule {
    @Provides
    fun retrofit(): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    @Provides
    fun shopApi(retrofit: Retrofit): ShopApi = retrofit.create(ShopApi::class.java)
}
