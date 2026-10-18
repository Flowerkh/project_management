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
