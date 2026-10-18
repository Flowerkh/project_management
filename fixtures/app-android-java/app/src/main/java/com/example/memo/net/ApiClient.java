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
