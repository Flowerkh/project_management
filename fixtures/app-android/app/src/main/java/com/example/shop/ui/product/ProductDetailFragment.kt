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
