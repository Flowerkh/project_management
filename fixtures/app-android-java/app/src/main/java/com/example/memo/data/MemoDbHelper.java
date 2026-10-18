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
