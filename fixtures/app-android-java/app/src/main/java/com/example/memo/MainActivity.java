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
