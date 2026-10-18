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
