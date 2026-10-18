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
