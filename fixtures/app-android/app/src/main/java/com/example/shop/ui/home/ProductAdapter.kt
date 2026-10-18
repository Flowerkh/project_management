package com.example.shop.ui.home

import androidx.recyclerview.widget.ListAdapter
import com.example.shop.data.local.ProductEntity

class ProductAdapter(private val onClick: (ProductEntity) -> Unit) : ListAdapter<ProductEntity, ProductViewHolder>(DIFF) {
    companion object {
        val DIFF = ProductDiff()
    }
}
