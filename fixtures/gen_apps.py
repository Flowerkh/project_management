#!/usr/bin/env python3
"""모바일 앱 예제 프로젝트 생성 (정답이 알려진 작은 프로젝트들)
사용: python3 fixtures/gen_apps.py [fixtures]
만드는 것: app-android(Kotlin MVVM), app-android-java, app-rn, app-flutter, app-with-server(Flutter + Go Gin API)
"""
import os
import shutil
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else 'fixtures'


def w(root, path, text, enc='utf-8'):
    p = os.path.join(BASE, root, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding=enc, newline='\n') as f:
        f.write(text.lstrip('\n'))


def reset(root):
    p = os.path.join(BASE, root)
    if os.path.exists(p):
        shutil.rmtree(p)


# ------------------------------------------------------------------ Android (Kotlin MVVM)
def android_kotlin():
    R = 'app-android'
    reset(R)
    K = 'app/src/main/java/com/example/shop'
    w(R, 'settings.gradle.kts', 'rootProject.name = "ShopApp"\ninclude(":app")\n')
    w(R, 'build.gradle.kts', '''
plugins {
    id("com.android.application") version "8.5.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
''')
    w(R, 'app/build.gradle.kts', '''
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("kotlin-kapt")
    id("com.google.dagger.hilt.android")
}

android {
    namespace = "com.example.shop"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.example.shop"
        minSdk = 24
        buildConfigField("String", "API_BASE_URL", "\\"https://api.example.com/api/\\"")
    }
    buildFeatures { viewBinding = true; buildConfig = true }
}

dependencies {
    implementation("androidx.navigation:navigation-fragment-ktx:2.7.7")
    implementation("androidx.navigation:navigation-ui-ktx:2.7.7")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")
    implementation("com.google.dagger:hilt-android:2.51")
}
''')
    w(R, 'app/src/main/AndroidManifest.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:name=".ShopApp"
        android:label="@string/app_name"
        android:theme="@style/Theme.Shop">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <activity
            android:name=".ui.notice.NoticeWebActivity"
            android:label="@string/title_notice" />
    </application>
</manifest>
''')
    w(R, 'app/src/main/res/values/strings.xml', '''
<resources>
    <string name="app_name">쇼핑몰</string>
    <string name="title_home">홈</string>
    <string name="title_orders">주문 내역</string>
    <string name="title_profile">내 정보</string>
    <string name="title_product_detail">상품 상세</string>
    <string name="title_order_detail">주문 상세</string>
    <string name="title_notice">공지사항</string>
    <string name="logout">로그아웃</string>
</resources>
''')
    w(R, 'app/src/main/res/values-en/strings.xml', '''
<resources>
    <string name="app_name">Shop</string>
    <string name="title_home">Home</string>
</resources>
''')
    w(R, 'app/src/main/res/menu/bottom_nav_menu.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<menu xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@+id/navigation_home" android:icon="@drawable/ic_home" android:title="@string/title_home" />
    <item android:id="@+id/navigation_orders" android:icon="@drawable/ic_orders" android:title="@string/title_orders" />
    <item android:id="@+id/navigation_profile" android:icon="@drawable/ic_profile" android:title="@string/title_profile" />
</menu>
''')
    w(R, 'app/src/main/res/navigation/mobile_navigation.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<navigation xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    xmlns:tools="http://schemas.android.com/tools"
    android:id="@+id/mobile_navigation"
    app:startDestination="@id/navigation_home">

    <fragment
        android:id="@+id/navigation_home"
        android:name="com.example.shop.ui.home.HomeFragment"
        android:label="@string/title_home"
        tools:layout="@layout/fragment_home">
        <action
            android:id="@+id/action_home_to_product"
            app:destination="@id/productDetailFragment" />
    </fragment>

    <fragment
        android:id="@+id/productDetailFragment"
        android:name="com.example.shop.ui.product.ProductDetailFragment"
        android:label="@string/title_product_detail"
        tools:layout="@layout/fragment_product_detail">
        <argument android:name="productId" app:argType="long" />
    </fragment>

    <fragment
        android:id="@+id/navigation_orders"
        android:name="com.example.shop.ui.orders.OrdersFragment"
        android:label="@string/title_orders"
        tools:layout="@layout/fragment_orders" />

    <fragment
        android:id="@+id/navigation_profile"
        android:name="com.example.shop.ui.profile.ProfileFragment"
        tools:layout="@layout/fragment_profile" />
</navigation>
''')
    w(R, 'app/src/main/res/layout/activity_main.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<androidx.constraintlayout.widget.ConstraintLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto"
    android:layout_width="match_parent" android:layout_height="match_parent">
    <androidx.fragment.app.FragmentContainerView
        android:id="@+id/nav_host_fragment"
        android:name="androidx.navigation.fragment.NavHostFragment"
        app:defaultNavHost="true"
        app:navGraph="@navigation/mobile_navigation" />
    <com.google.android.material.bottomnavigation.BottomNavigationView
        android:id="@+id/nav_view"
        app:menu="@menu/bottom_nav_menu" />
</androidx.constraintlayout.widget.ConstraintLayout>
''')
    w(R, 'app/src/main/res/layout/view_toolbar.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<com.google.android.material.appbar.MaterialToolbar xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/toolbar" android:layout_width="match_parent" android:layout_height="?attr/actionBarSize" />
''')
    w(R, 'app/src/main/res/layout/fragment_home.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:orientation="vertical"
    android:layout_width="match_parent" android:layout_height="match_parent">
    <include layout="@layout/view_toolbar" />
    <androidx.recyclerview.widget.RecyclerView android:id="@+id/product_list"
        android:layout_width="match_parent" android:layout_height="match_parent" />
</LinearLayout>
''')
    w(R, 'app/src/main/res/layout/fragment_product_detail.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:orientation="vertical">
    <TextView android:id="@+id/product_name" />
    <Button android:id="@+id/btn_order" android:text="주문하기" />
</LinearLayout>
''')
    w(R, 'app/src/main/res/layout/fragment_orders.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<androidx.recyclerview.widget.RecyclerView xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/order_list" android:layout_width="match_parent" android:layout_height="match_parent" />
''')
    w(R, 'app/src/main/res/layout/fragment_profile.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android" android:orientation="vertical">
    <TextView android:id="@+id/tv_title" android:text="@string/title_profile" />
    <Button android:id="@+id/btn_logout" android:text="@string/logout" />
</LinearLayout>
''')
    w(R, 'app/src/main/res/layout/activity_notice_web.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<WebView xmlns:android="http://schemas.android.com/apk/res/android" android:id="@+id/web_view"
    android:layout_width="match_parent" android:layout_height="match_parent" />
''')
    w(R, f'{K}/ShopApp.kt', '''
package com.example.shop

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class ShopApp : Application()
''')
    w(R, f'{K}/MainActivity.kt', '''
package com.example.shop

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.navigation.findNavController
import androidx.navigation.ui.setupWithNavController
import com.example.shop.databinding.ActivityMainBinding
import dagger.hilt.android.AndroidEntryPoint

/** 앱 첫 화면: 하단 탭과 내비게이션 호스트 */
@AndroidEntryPoint
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        val navController = findNavController(R.id.nav_host_fragment)
        binding.navView.setupWithNavController(navController)
    }
}
''')
    w(R, f'{K}/ui/home/HomeFragment.kt', '''
package com.example.shop.ui.home

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import androidx.navigation.fragment.findNavController
import com.example.shop.R
import com.example.shop.databinding.FragmentHomeBinding
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class HomeFragment : Fragment() {

    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!
    private val viewModel: HomeViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val adapter = ProductAdapter { product ->
            findNavController().navigate(R.id.action_home_to_product, Bundle().apply { putLong("productId", product.id) })
        }
        binding.productList.adapter = adapter
        viewModel.products.observe(viewLifecycleOwner) { adapter.submitList(it) }
        viewModel.load()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
''')
    w(R, f'{K}/ui/home/HomeViewModel.kt', '''
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
''')
    w(R, f'{K}/ui/home/ProductAdapter.kt', '''
package com.example.shop.ui.home

import androidx.recyclerview.widget.ListAdapter
import com.example.shop.data.local.ProductEntity

class ProductAdapter(private val onClick: (ProductEntity) -> Unit) : ListAdapter<ProductEntity, ProductViewHolder>(DIFF) {
    companion object {
        val DIFF = ProductDiff()
    }
}
''')
    w(R, f'{K}/ui/product/ProductDetailFragment.kt', '''
package com.example.shop.ui.product

import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import com.example.shop.R
import com.example.shop.databinding.FragmentProductDetailBinding
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class ProductDetailFragment : Fragment(R.layout.fragment_product_detail) {

    private val viewModel: ProductDetailViewModel by viewModels()

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val binding = FragmentProductDetailBinding.bind(view)
        val id = requireArguments().getLong("productId")
        viewModel.product(id).observe(viewLifecycleOwner) { binding.productName.text = it.name }
        binding.btnOrder.setOnClickListener { order(id) }
    }

    private fun order(id: Long) {
        viewModel.placeOrder(id, 1)
    }
}
''')
    w(R, f'{K}/ui/product/ProductDetailViewModel.kt', '''
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
''')
    w(R, f'{K}/ui/orders/OrdersFragment.kt', '''
package com.example.shop.ui.orders

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import com.example.shop.R

class OrdersFragment : Fragment() {

    private lateinit var viewModel: OrdersViewModel

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        viewModel = ViewModelProvider(this)[OrdersViewModel::class.java]
        return inflater.inflate(R.layout.fragment_orders, container, false)
    }

    override fun onResume() {
        super.onResume()
        viewModel.refresh()
    }
}
''')
    w(R, f'{K}/ui/orders/OrdersViewModel.kt', '''
package com.example.shop.ui.orders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.shop.data.repository.OrderRepository
import kotlinx.coroutines.launch
import javax.inject.Inject

class OrdersViewModel @Inject constructor(private val repo: OrderRepository) : ViewModel() {
    fun refresh() {
        viewModelScope.launch { repo.getOrders() }
    }
}
''')
    w(R, f'{K}/ui/profile/ProfileFragment.kt', '''
package com.example.shop.ui.profile

import android.os.Bundle
import android.view.View
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import com.example.shop.R
import com.example.shop.databinding.FragmentProfileBinding

class ProfileFragment : Fragment(R.layout.fragment_profile) {
    private val vm by viewModels<ProfileViewModel>()

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val binding = FragmentProfileBinding.bind(view)
        binding.btnLogout.setOnClickListener { vm.logout() }
    }
}
''')
    w(R, f'{K}/ui/profile/ProfileViewModel.kt', '''
package com.example.shop.ui.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.shop.data.repository.UserRepository
import kotlinx.coroutines.launch
import javax.inject.Inject

class ProfileViewModel @Inject constructor(private val users: UserRepository) : ViewModel() {
    init {
        viewModelScope.launch { users.loadMe() }
    }

    fun logout() {
        viewModelScope.launch { users.logout() }
    }
}
''')
    w(R, f'{K}/ui/notice/NoticeWebActivity.kt', '''
package com.example.shop.ui.notice

import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import com.example.shop.R

/** 공지사항 웹 화면 (하이브리드) */
class NoticeWebActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_notice_web)
        val web = findViewById<WebView>(R.id.web_view)
        web.settings.javaScriptEnabled = true
        web.loadUrl(NOTICE_URL)
    }

    companion object {
        const val NOTICE_URL = "https://m.example.com/notice/list.do"
    }
}
''')
    w(R, f'{K}/data/remote/ShopApi.kt', '''
package com.example.shop.data.remote

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface ShopApi {
    @GET("products")
    suspend fun getProducts(): List<ProductDto>

    @GET("products/{id}")
    suspend fun getProduct(@Path("id") id: Long): ProductDto

    @GET("orders")
    suspend fun getOrders(): List<OrderDto>

    @POST("orders")
    suspend fun createOrder(@Body req: OrderRequest): OrderDto

    @GET("users/me")
    suspend fun getMe(): UserDto
}
''')
    w(R, f'{K}/data/remote/Dtos.kt', '''
package com.example.shop.data.remote

data class ProductDto(val id: Long, val name: String, val price: Int)
data class OrderDto(val id: Long, val productId: Long, val qty: Int, val status: String)
data class OrderRequest(val productId: Long, val qty: Int)
data class UserDto(val id: Long, val name: String)
''')
    w(R, f'{K}/di/NetworkModule.kt', '''
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
''')
    w(R, f'{K}/data/local/Entities.kt', '''
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
''')
    w(R, f'{K}/data/local/ProductDao.kt', '''
package com.example.shop.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface ProductDao {
    @Query("SELECT * FROM products ORDER BY name")
    suspend fun getAll(): List<ProductEntity>

    @Query("SELECT * FROM products WHERE id = :id")
    suspend fun findById(id: Long): ProductEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(items: List<ProductEntity>)
}
''')
    w(R, f'{K}/data/local/OrderDao.kt', '''
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
''')
    w(R, f'{K}/data/local/UserDao.kt', '''
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
''')
    w(R, f'{K}/data/local/AppDatabase.kt', '''
package com.example.shop.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(entities = [ProductEntity::class, OrderEntity::class, UserEntity::class], version = 1)
abstract class AppDatabase : RoomDatabase() {
    abstract fun productDao(): ProductDao
    abstract fun orderDao(): OrderDao
    abstract fun userDao(): UserDao
}
''')
    w(R, f'{K}/data/repository/ProductRepository.kt', '''
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
''')
    w(R, f'{K}/data/repository/OrderRepository.kt', '''
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
''')
    w(R, f'{K}/data/repository/UserRepository.kt', '''
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
''')


# ------------------------------------------------------------------ Android (Java)
def android_java():
    R = 'app-android-java'
    reset(R)
    J = 'app/src/main/java/com/example/memo'
    w(R, 'settings.gradle', "include ':app'\n")
    w(R, 'app/build.gradle', '''
apply plugin: 'com.android.application'

android {
    namespace 'com.example.memo'
    compileSdkVersion 34
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.android.volley:volley:1.2.1'
}
''')
    w(R, 'app/src/main/AndroidManifest.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.memo">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:label="@string/app_name">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <activity android:name=".MemoEditActivity" />
        <activity android:name="com.example.memo.SettingsActivity" />
    </application>
</manifest>
''')
    w(R, 'app/src/main/res/values/strings.xml', '''
<resources>
    <string name="app_name">메모장</string>
    <string name="title_edit">메모 작성</string>
    <string name="title_settings">설정</string>
    <string name="action_settings">설정</string>
</resources>
''')
    w(R, 'app/src/main/res/layout/activity_main.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<ListView xmlns:android="http://schemas.android.com/apk/res/android" android:id="@+id/memo_list" />
''')
    w(R, 'app/src/main/res/layout/activity_memo_edit.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto" android:orientation="vertical">
    <androidx.appcompat.widget.Toolbar android:id="@+id/toolbar" app:title="@string/title_edit" />
    <EditText android:id="@+id/edit_title" />
    <EditText android:id="@+id/edit_body" />
</LinearLayout>
''')
    w(R, 'app/src/main/res/menu/main_menu.xml', '''
<?xml version="1.0" encoding="utf-8"?>
<menu xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:id="@+id/action_settings" android:title="@string/action_settings" />
</menu>
''')
    w(R, f'{J}/MainActivity.java', '''
package com.example.memo;

import android.content.Intent;
import android.os.Bundle;
import android.view.MenuItem;
import androidx.appcompat.app.AppCompatActivity;
import com.example.memo.data.MemoDbHelper;
import com.example.memo.net.ApiClient;
import java.util.List;

/** 메모 목록 */
public class MainActivity extends AppCompatActivity {
    private MemoDbHelper dbHelper;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        dbHelper = new MemoDbHelper(this);
        loadMemos();
    }

    private void loadMemos() {
        List<String> memos = dbHelper.getAll();
        ApiClient.fetchMemos(this);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case R.id.action_settings:
                startActivity(new Intent(this, SettingsActivity.class));
                return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
''')
    w(R, f'{J}/MemoEditActivity.java', '''
package com.example.memo;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import com.example.memo.data.MemoDbHelper;

public class MemoEditActivity extends AppCompatActivity {
    private MemoDbHelper dbHelper;
    private long memoId = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_memo_edit);
        dbHelper = new MemoDbHelper(this);
        findViewById(R.id.btn_save).setOnClickListener(v -> save());
    }

    private void save() {
        if (memoId < 0) dbHelper.insert("title", "body");
        else dbHelper.update(memoId, "title", "body");
    }

    private void remove() {
        dbHelper.delete(memoId);
    }
}
''')
    w(R, f'{J}/SettingsActivity.java', '''
package com.example.memo;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

public class SettingsActivity extends AppCompatActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle(R.string.title_settings);
    }
}
''')
    w(R, f'{J}/data/MemoDbHelper.java', '''
package com.example.memo.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.util.ArrayList;
import java.util.List;

public class MemoDbHelper extends SQLiteOpenHelper {
    private static final String DB_NAME = "memo.db";
    public static final String TABLE_MEMO = "memo";

    public MemoDbHelper(Context context) {
        super(context, DB_NAME, null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE " + TABLE_MEMO + " (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT, updated_at INTEGER)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS " + TABLE_MEMO);
        onCreate(db);
    }

    public List<String> getAll() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT id, title, body FROM memo ORDER BY updated_at DESC", null);
        List<String> out = new ArrayList<>();
        while (c.moveToNext()) out.add(c.getString(1));
        c.close();
        return out;
    }

    public long insert(String title, String body) {
        ContentValues values = new ContentValues();
        values.put("title", title);
        values.put("body", body);
        return getWritableDatabase().insert(TABLE_MEMO, null, values);
    }

    public int update(long id, String title, String body) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues values = new ContentValues();
        values.put("title", title);
        return db.update("memo", values, "id = ?", new String[] { String.valueOf(id) });
    }

    public void delete(long id) {
        SQLiteDatabase db = getWritableDatabase();
        db.delete(TABLE_MEMO, "id = ?", new String[] { String.valueOf(id) });
    }
}
''')
    w(R, f'{J}/net/ApiClient.java', '''
package com.example.memo.net;

import android.content.Context;
import com.android.volley.Request;
import com.android.volley.toolbox.StringRequest;
import com.android.volley.toolbox.Volley;

public class ApiClient {
    private static final String BASE_URL = "https://memo.example.com/api";

    public static void fetchMemos(Context context) {
        StringRequest req = new StringRequest(Request.Method.GET, BASE_URL + "/memos",
            response -> { },
            error -> { });
        Volley.newRequestQueue(context).add(req);
    }
}
''')


# ------------------------------------------------------------------ React Native
def react_native():
    R = 'app-rn'
    reset(R)
    w(R, 'package.json', """
{
  "name": "shop-rn",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "react": "18.2.0",
    "react-native": "0.74.1",
    "@react-navigation/native": "^6.1.17",
    "@react-navigation/native-stack": "^6.9.26",
    "@react-navigation/bottom-tabs": "^6.5.20",
    "axios": "^1.6.8",
    "react-native-config": "^1.5.1",
    "react-native-sqlite-storage": "^6.0.1",
    "react-native-webview": "^13.8.6"
  }
}
""")
    w(R, '.env', 'API_URL=https://api.example.com/api\n')
    w(R, 'index.js', """
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
""")
    w(R, 'App.tsx', """
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MainTabs from './src/navigation/MainTabs';
import ProductDetailScreen from './src/screens/ProductDetailScreen';
import NoticeScreen from './src/screens/NoticeScreen';
import { init } from './src/db/cartDb';

const Stack = createNativeStackNavigator();

export default function App() {
  React.useEffect(() => {
    init();
  }, []);
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
        <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: '상품 상세' }} />
        <Stack.Screen name="Notice" component={NoticeScreen} options={{ title: '공지사항' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
""")
    w(R, 'src/navigation/MainTabs.tsx', """
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/HomeScreen';
import CartScreen from '../screens/CartScreen';
import OrdersStack from './OrdersStack';

const Tab = createBottomTabNavigator();

export default function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: '홈' }} />
      <Tab.Screen name="Orders" component={OrdersStack} options={{ tabBarLabel: '주문', headerShown: false }} />
      <Tab.Screen name="Cart" component={CartScreen} options={{ tabBarLabel: '장바구니' }} />
    </Tab.Navigator>
  );
}
""")
    w(R, 'src/navigation/OrdersStack.tsx', """
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { OrderListScreen, OrderDetailScreen } from '../screens';

const Stack = createNativeStackNavigator();

const OrdersStack = () => (
  <Stack.Navigator>
    <Stack.Screen name="OrderList" component={OrderListScreen} options={{ title: '주문 내역' }} />
    <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: '주문 상세' }} />
  </Stack.Navigator>
);

export default OrdersStack;
""")
    w(R, 'src/screens/index.ts', """
export { default as OrderListScreen } from './orders/OrderListScreen';
export { default as OrderDetailScreen } from './orders/OrderDetailScreen';
""")
    w(R, 'src/screens/HomeScreen.tsx', """
import React, { useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity } from 'react-native';
import { productApi } from '../api/productApi';

export default function HomeScreen({ navigation }) {
  const [products, setProducts] = useState([]);
  useEffect(() => {
    productApi.list().then((res) => setProducts(res.data));
  }, []);
  return (
    <FlatList
      data={products}
      renderItem={({ item }) => (
        <TouchableOpacity onPress={() => navigation.navigate('ProductDetail', { id: item.id })}>
          <Text>{item.name}</Text>
        </TouchableOpacity>
      )}
    />
  );
}
""")
    w(R, 'src/screens/ProductDetailScreen.tsx', """
import React from 'react';
import { Button, View } from 'react-native';
import * as cartDb from '../db/cartDb';
import { productApi } from '../api/productApi';

const ProductDetailScreen = ({ route }) => {
  const { id } = route.params;
  const [product, setProduct] = React.useState(null);
  React.useEffect(() => {
    productApi.get(id).then((r) => setProduct(r.data));
  }, [id]);
  const addToCart = () => {
    cartDb.addItem(id, 1);
  };
  return (
    <View>
      <Button title="장바구니 담기" onPress={addToCart} />
    </View>
  );
};

export default ProductDetailScreen;
""")
    w(R, 'src/screens/orders/OrderListScreen.tsx', """
import React from 'react';
import { FlatList } from 'react-native';
import { useOrders } from '../../hooks/useOrders';
import OrderRow from '../../components/OrderRow';

export default function OrderListScreen() {
  const orders = useOrders();
  return <FlatList data={orders} renderItem={({ item }) => <OrderRow order={item} />} />;
}
""")
    w(R, 'src/screens/orders/OrderDetailScreen.tsx', """
import React, { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';
import * as orderApi from '../../api/orderApi';

export default function OrderDetailScreen({ route, navigation }) {
  const [order, setOrder] = useState(null);
  useEffect(() => {
    orderApi.getOrder(route.params.id).then(setOrder);
  }, []);

  async function onCancel() {
    await orderApi.cancel(route.params.id);
    navigation.goBack();
  }

  return (
    <View>
      <Text>{order?.status}</Text>
      <Button title="주문 취소" onPress={onCancel} />
    </View>
  );
}
""")
    w(R, 'src/screens/CartScreen.tsx', """
import React, { useEffect, useState } from 'react';
import { Button, View } from 'react-native';
import * as cartDb from '../db/cartDb';
import { create } from '../api/orderApi';

export default function CartScreen() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    cartDb.getItems().then(setItems);
  }, []);

  const checkout = async () => {
    await create(items);
    cartDb.clear();
  };

  return (
    <View>
      <Button title="주문하기" onPress={checkout} />
    </View>
  );
}
""")
    w(R, 'src/screens/NoticeScreen.tsx', """
import React from 'react';
import { WebView } from 'react-native-webview';

export default function NoticeScreen() {
  return <WebView source={{ uri: 'https://m.example.com/notice/list.do' }} />;
}
""")
    w(R, 'src/components/OrderRow.tsx', """
import React from 'react';
import { Text } from 'react-native';

export default function OrderRow({ order }) {
  return <Text>{order.id}</Text>;
}
""")
    w(R, 'src/hooks/useOrders.ts', """
import { useEffect, useState } from 'react';
import { getOrders } from '../api/orderApi';

export function useOrders() {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    getOrders().then(setOrders);
  }, []);
  return orders;
}
""")
    w(R, 'src/api/client.ts', """
import axios from 'axios';
import Config from 'react-native-config';

const client = axios.create({
  baseURL: Config.API_URL,
  timeout: 10000,
});

export default client;
""")
    w(R, 'src/api/productApi.ts', """
import client from './client';

export const productApi = {
  list: () => client.get('/products'),
  get: (id: number) => client.get(`/products/${id}`),
};
""")
    w(R, 'src/api/orderApi.ts', """
import client from './client';

export async function getOrders() {
  const res = await client.get('/orders');
  return res.data;
}

export async function getOrder(id: number) {
  const res = await client.get(`/orders/${id}`);
  return res.data;
}

export const cancel = (id: number) => client.delete(`/orders/${id}`);

export function create(items: unknown[]) {
  return client.post('/orders', { items });
}
""")
    w(R, 'src/db/cartDb.ts', """
import SQLite from 'react-native-sqlite-storage';

const db = SQLite.openDatabase({ name: 'cart.db', location: 'default' });
const TABLE = 'cart_items';

export function init() {
  db.transaction((tx) => {
    tx.executeSql('CREATE TABLE IF NOT EXISTS cart_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, qty INTEGER NOT NULL)');
  });
}

export function addItem(productId: number, qty: number) {
  db.transaction((tx) => {
    tx.executeSql('INSERT INTO cart_items (product_id, qty) VALUES (?, ?)', [productId, qty]);
  });
}

export function getItems(): Promise<unknown[]> {
  return new Promise((resolve) => {
    db.transaction((tx) => {
      tx.executeSql(`SELECT * FROM ${TABLE} ORDER BY id`, [], (_, rs) => resolve(rs.rows.raw()));
    });
  });
}

export function clear() {
  db.transaction((tx) => tx.executeSql('DELETE FROM cart_items'));
}
""")
    w(R, 'android/app/src/main/AndroidManifest.xml', """
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
""")
    w(R, 'android/app/src/main/java/com/shoprn/MainActivity.kt', """
package com.shoprn

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
    override fun getMainComponentName(): String = "shop-rn"
}
""")
    w(R, 'ios/ShopRn/AppDelegate.mm', '// iOS (분석 제외)\n')


# ------------------------------------------------------------------ Flutter
def flutter():
    R = 'app-flutter'
    reset(R)
    w(R, 'pubspec.yaml', """
name: shop_flutter
description: 쇼핑 앱
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  flutter_localizations:
    sdk: flutter
  go_router: ^14.1.0
  dio: ^5.4.3
  sqflite: ^2.3.3
  provider: ^6.1.2

flutter:
  uses-material-design: true
  generate: true
""")
    w(R, 'lib/l10n/app_ko.arb', """
{
  "@@locale": "ko",
  "productDetail": "상품 상세",
  "@productDetail": { "description": "상품 상세 화면 제목" }
}
""")
    w(R, 'lib/l10n/app_en.arb', '{\n  "@@locale": "en",\n  "productDetail": "Product detail"\n}\n')
    w(R, 'lib/main.dart', """
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shop_flutter/router.dart';
import 'package:shop_flutter/data/api_client.dart';
import 'package:shop_flutter/data/product_repository.dart';
import 'package:shop_flutter/models/order_model.dart';

void main() {
  runApp(
    MultiProvider(
      providers: [
        Provider(create: (_) => ProductRepository(ApiClient.dio)),
        ChangeNotifierProvider(create: (_) => OrderModel()),
      ],
      child: const ShopApp(),
    ),
  );
}

class ShopApp extends StatelessWidget {
  const ShopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(title: '쇼핑', routerConfig: router);
  }
}
""")
    w(R, 'lib/router.dart', """
import 'package:go_router/go_router.dart';
import 'screens/main_shell.dart';
import 'screens/product_detail_screen.dart';
import 'screens/order_list_screen.dart';
import 'screens/order_detail_screen.dart';

final router = GoRouter(
  initialLocation: '/home',
  routes: [
    GoRoute(path: '/home', builder: (context, state) => const MainShell()),
    GoRoute(
      path: '/products/:id',
      builder: (context, state) => ProductDetailScreen(id: int.parse(state.pathParameters['id']!)),
    ),
    GoRoute(
      path: '/orders',
      builder: (context, state) => const OrderListScreen(),
      routes: [
        GoRoute(
          path: ':id',
          builder: (context, state) => OrderDetailScreen(id: state.pathParameters['id']!),
        ),
      ],
    ),
  ],
);
""")
    w(R, 'lib/screens/main_shell.dart', """
import 'package:flutter/material.dart';
import 'home_screen.dart';
import 'order_list_screen.dart';
import 'cart_screen.dart';

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;
  final _pages = const [HomeScreen(), OrderListScreen(), CartScreen()];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _pages[_index],
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _index,
        onTap: (i) => setState(() => _index = i),
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.home), label: '홈'),
          BottomNavigationBarItem(icon: Icon(Icons.receipt_long), label: '주문'),
          BottomNavigationBarItem(icon: Icon(Icons.shopping_cart), label: '장바구니'),
        ],
      ),
    );
  }
}
""")
    w(R, 'lib/screens/home_screen.dart', """
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../data/product_repository.dart';
import '../models/product.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<List<Product>> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<ProductRepository>().fetchProducts();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('홈')),
      body: FutureBuilder<List<Product>>(
        future: _future,
        builder: (context, snap) => ListView(
          children: [
            for (final p in snap.data ?? <Product>[])
              ListTile(title: Text(p.name), onTap: () => context.push('/products/${p.id}')),
          ],
        ),
      ),
    );
  }
}
""")
    w(R, 'lib/screens/product_detail_screen.dart', """
import 'package:flutter/material.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';
import '../db/cart_db.dart';

class ProductDetailScreen extends StatelessWidget {
  final int id;
  const ProductDetailScreen({super.key, required this.id});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(AppLocalizations.of(context)!.productDetail)),
      body: ElevatedButton(
        onPressed: () => CartDb.instance.add(id, 1),
        child: const Text('장바구니 담기'),
      ),
    );
  }
}
""")
    w(R, 'lib/screens/order_list_screen.dart', """
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import '../models/order_model.dart';

class OrderListScreen extends StatelessWidget {
  const OrderListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final model = context.watch<OrderModel>();
    return Scaffold(
      appBar: AppBar(title: const Text('주문 내역')),
      body: RefreshIndicator(
        onRefresh: () => context.read<OrderModel>().load(),
        child: ListView(
          children: model.orders.map((o) => ListTile(title: Text(o.status), onTap: () => context.go('/orders/${o.id}'))).toList(),
        ),
      ),
    );
  }
}
""")
    w(R, 'lib/screens/order_detail_screen.dart', """
import 'package:flutter/material.dart';
import '../data/order_api.dart';
import '../models/order.dart';

class OrderDetailScreen extends StatefulWidget {
  final String id;
  const OrderDetailScreen({super.key, required this.id});

  @override
  State<OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<OrderDetailScreen> {
  final _api = OrderApi();
  Order? _order;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final o = await _api.getOrder(widget.id);
    setState(() => _order = o);
  }

  Future<void> _cancel() async {
    await _api.cancel(widget.id);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('주문 상세')),
      body: TextButton(onPressed: _cancel, child: Text(_order?.status ?? '')),
    );
  }
}
""")
    w(R, 'lib/screens/cart_screen.dart', """
import 'package:flutter/material.dart';
import '../db/cart_db.dart';
import '../data/order_api.dart';

class CartScreen extends StatelessWidget {
  const CartScreen({super.key});

  Future<void> _checkout() async {
    final items = await CartDb.instance.items();
    await OrderApi().create(items);
    await CartDb.instance.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('장바구니')),
      floatingActionButton: FloatingActionButton(onPressed: _checkout, child: const Icon(Icons.payment)),
    );
  }
}
""")
    w(R, 'lib/data/api_client.dart', """
import 'package:dio/dio.dart';

class ApiClient {
  static const baseUrl = 'https://api.example.com/api';
  static final Dio dio = Dio(BaseOptions(baseUrl: baseUrl, connectTimeout: const Duration(seconds: 5)));
}
""")
    w(R, 'lib/data/product_repository.dart', """
import 'package:dio/dio.dart';
import '../models/product.dart';

class ProductRepository {
  final Dio _dio;
  ProductRepository(this._dio);

  Future<List<Product>> fetchProducts() async {
    final res = await _dio.get('/products');
    return (res.data as List).map((e) => Product.fromJson(e)).toList();
  }
}
""")
    w(R, 'lib/data/order_api.dart', """
import 'api_client.dart';
import '../models/order.dart';

class OrderApi {
  final _dio = ApiClient.dio;

  Future<List<Order>> fetchOrders() async {
    final res = await _dio.get('/orders');
    return (res.data as List).map((e) => Order.fromJson(e)).toList();
  }

  Future<Order> getOrder(String id) async {
    final res = await _dio.get('/orders/$id');
    return Order.fromJson(res.data);
  }

  Future<void> cancel(String id) => _dio.delete('/orders/$id');

  Future<void> create(List<Map<String, Object?>> items) async {
    await _dio.post('/orders', data: {'items': items});
  }
}
""")
    w(R, 'lib/models/order_model.dart', """
import 'package:flutter/foundation.dart';
import '../data/order_api.dart';
import 'order.dart';

class OrderModel extends ChangeNotifier {
  final OrderApi _api = OrderApi();
  List<Order> orders = [];

  Future<void> load() async {
    orders = await _api.fetchOrders();
    notifyListeners();
  }
}
""")
    w(R, 'lib/models/order.dart', """
class Order {
  final int id;
  final String status;
  Order(this.id, this.status);
  factory Order.fromJson(Map<String, dynamic> j) => Order(j['id'], j['status']);
}
""")
    w(R, 'lib/models/product.dart', """
class Product {
  final int id;
  final String name;
  Product(this.id, this.name);
  factory Product.fromJson(Map<String, dynamic> j) => Product(j['id'], j['name']);
}
""")
    w(R, 'lib/db/cart_db.dart', """
import 'package:sqflite/sqflite.dart';

class CartDb {
  CartDb._();
  static final CartDb instance = CartDb._();
  static const table = 'cart_items';
  Database? _db;

  Future<Database> get database async {
    _db ??= await openDatabase('cart.db', version: 1, onCreate: (db, version) async {
      await db.execute('CREATE TABLE cart_items (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, qty INTEGER NOT NULL)');
    });
    return _db!;
  }

  Future<void> add(int productId, int qty) async {
    final db = await database;
    await db.insert(table, {'product_id': productId, 'qty': qty});
  }

  Future<List<Map<String, Object?>>> items() async {
    final db = await database;
    return db.query(table, orderBy: 'id');
  }

  Future<void> clear() async {
    final db = await database;
    await db.delete(table);
  }
}
""")
    w(R, 'android/app/src/main/AndroidManifest.xml', """
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="shop_flutter">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
""")
    w(R, 'android/app/src/main/kotlin/com/example/shop_flutter/MainActivity.kt', """
package com.example.shop_flutter

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
""")
    w(R, 'android/app/build.gradle', "plugins {\n    id 'com.android.application'\n    id 'dev.flutter.flutter-gradle-plugin'\n}\n")
    w(R, 'web/index.html', '<!DOCTYPE html>\n<html><head><title>shop_flutter</title></head><body><script src="flutter_bootstrap.js" async></script></body></html>\n')
    w(R, 'ios/Runner/AppDelegate.swift', 'import Flutter\n')


# ------------------------------------------------------------------ Flutter 앱 + Go(Gin) API 서버
def app_with_server():
    R = 'app-with-server'
    reset(R)
    w(R, 'README.md', '현장 작업 앱과 API 서버\n')
    w(R, 'app/pubspec.yaml', """
name: field_app
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.1
""")
    w(R, 'app/lib/main.dart', """
import 'package:flutter/material.dart';
import 'screens/task_list_screen.dart';
import 'screens/task_detail_screen.dart';

void main() => runApp(const FieldApp());

class FieldApp extends StatelessWidget {
  const FieldApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      routes: {
        '/': (context) => const TaskListScreen(),
        '/detail': (context) => const TaskDetailScreen(),
      },
    );
  }
}
""")
    w(R, 'app/lib/config.dart', "const String kBaseUrl = 'http://10.0.2.2:8080/api/v1';\n")
    w(R, 'app/lib/api/task_api.dart', """
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config.dart';

class TaskApi {
  Future<List<dynamic>> fetchTasks() async {
    final res = await http.get(Uri.parse('$kBaseUrl/tasks'));
    return jsonDecode(res.body);
  }

  Future<Map<String, dynamic>> getTask(int id) async {
    final res = await http.get(Uri.parse('$kBaseUrl/tasks/$id'));
    return jsonDecode(res.body);
  }

  Future<void> create(String title) async {
    final uri = Uri.parse('$kBaseUrl/tasks');
    await http.post(uri, body: jsonEncode({'title': title}));
  }

  Future<void> complete(int id) async {
    await http.put(Uri.parse('$kBaseUrl/tasks/$id/complete'));
  }
}
""")
    w(R, 'app/lib/screens/task_list_screen.dart', """
import 'package:flutter/material.dart';
import '../api/task_api.dart';
import 'task_form_screen.dart';

class TaskListScreen extends StatefulWidget {
  const TaskListScreen({super.key});

  @override
  State<TaskListScreen> createState() => _TaskListScreenState();
}

class _TaskListScreenState extends State<TaskListScreen> {
  final api = TaskApi();
  List<dynamic> tasks = [];

  @override
  void initState() {
    super.initState();
    api.fetchTasks().then((t) => setState(() => tasks = t));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('작업 목록')),
      body: ListView(children: [for (final t in tasks) ListTile(title: Text(t['title']), onTap: () => Navigator.pushNamed(context, '/detail'))]),
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const TaskFormScreen())),
        child: const Icon(Icons.add),
      ),
    );
  }
}
""")
    w(R, 'app/lib/screens/task_detail_screen.dart', """
import 'package:flutter/material.dart';
import '../api/task_api.dart';

class TaskDetailScreen extends StatelessWidget {
  const TaskDetailScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final id = ModalRoute.of(context)!.settings.arguments as int;
    return Scaffold(
      appBar: AppBar(title: const Text('작업 상세')),
      body: FutureBuilder(future: TaskApi().getTask(id), builder: (c, s) => Text('${s.data}')),
      floatingActionButton: FloatingActionButton(onPressed: () => TaskApi().complete(id), child: const Icon(Icons.check)),
    );
  }
}
""")
    w(R, 'app/lib/screens/task_form_screen.dart', """
import 'package:flutter/material.dart';
import '../api/task_api.dart';

class TaskFormScreen extends StatelessWidget {
  const TaskFormScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('작업 등록')),
      body: ElevatedButton(onPressed: () => TaskApi().create('new'), child: const Text('저장')),
    );
  }
}
""")
    w(R, 'server/go.mod', """
module example.com/fieldsvc

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/go-sql-driver/mysql v1.8.1
)
""")
    w(R, 'server/main.go', """
package main

import (
	"database/sql"

	"example.com/fieldsvc/handler"
	"example.com/fieldsvc/repository"
	"github.com/gin-gonic/gin"
	_ "github.com/go-sql-driver/mysql"
)

func main() {
	db, _ := sql.Open("mysql", "app:pass@tcp(db:3306)/field")
	repo := repository.NewTaskRepository(db)
	h := handler.NewTaskHandler(repo)

	r := gin.Default()
	api := r.Group("/api/v1")
	{
		api.GET("/tasks", h.ListTasks)
		api.GET("/tasks/:id", h.GetTask)
		api.POST("/tasks", h.CreateTask)
		api.PUT("/tasks/:id/complete", h.CompleteTask)
		api.GET("/health", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	}
	r.Run(":8080")
}
""")
    w(R, 'server/handler/task.go', """
package handler

import (
	"net/http"
	"strconv"

	"example.com/fieldsvc/repository"
	"github.com/gin-gonic/gin"
)

type TaskHandler struct {
	repo *repository.TaskRepository
}

func NewTaskHandler(r *repository.TaskRepository) *TaskHandler {
	return &TaskHandler{repo: r}
}

// ListTasks 작업 목록
func (h *TaskHandler) ListTasks(c *gin.Context) {
	tasks, _ := h.repo.FindAll()
	c.JSON(http.StatusOK, tasks)
}

func (h *TaskHandler) GetTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	t, _ := h.repo.FindByID(id)
	c.JSON(http.StatusOK, t)
}

func (h *TaskHandler) CreateTask(c *gin.Context) {
	var body struct{ Title string }
	c.BindJSON(&body)
	h.repo.Insert(body.Title)
	c.Status(http.StatusCreated)
}

func (h *TaskHandler) CompleteTask(c *gin.Context) {
	id, _ := strconv.Atoi(c.Param("id"))
	h.repo.Complete(id)
	c.Status(http.StatusNoContent)
}
""")
    w(R, 'server/repository/task.go', """
package repository

import "database/sql"

type TaskRepository struct {
	db *sql.DB
}

func NewTaskRepository(db *sql.DB) *TaskRepository { return &TaskRepository{db: db} }

func (r *TaskRepository) FindAll() ([]map[string]any, error) {
	rows, err := r.db.Query("SELECT id, title, status FROM tb_task ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return nil, nil
}

func (r *TaskRepository) FindByID(id int) (map[string]any, error) {
	row := r.db.QueryRow("SELECT id, title, status FROM tb_task WHERE id = ?", id)
	_ = row
	return nil, nil
}

func (r *TaskRepository) Insert(title string) error {
	_, err := r.db.Exec("INSERT INTO tb_task (title, status) VALUES (?, 'OPEN')", title)
	return err
}

func (r *TaskRepository) Complete(id int) error {
	if _, err := r.db.Exec("UPDATE tb_task SET status = 'DONE' WHERE id = ?", id); err != nil {
		return err
	}
	_, err := r.db.Exec("INSERT INTO tb_task_log (task_id, action) VALUES (?, 'COMPLETE')", id)
	return err
}
""")
    w(R, 'server/schema.sql', """
CREATE TABLE tb_task (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '작업 ID',
  title VARCHAR(200) NOT NULL COMMENT '제목',
  status VARCHAR(20) NOT NULL COMMENT '상태'
) COMMENT='작업';

CREATE TABLE tb_task_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT NOT NULL COMMENT '작업 ID',
  action VARCHAR(20) NOT NULL COMMENT '동작'
) COMMENT='작업 이력';
""")


if __name__ == '__main__':
    android_kotlin()
    android_java()
    react_native()
    flutter()
    app_with_server()
    print('ok')
