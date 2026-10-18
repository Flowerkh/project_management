#!/usr/bin/env python
"""일별 정산 배치: 전날 주문을 모아 정산 테이블에 쌓는다."""
import logging

import pymysql

logging.basicConfig(filename='/var/log/shop/daily_settle.log', level=logging.INFO)

INSERT_SQL = (
    "INSERT INTO tb_settle_daily (settle_date, amount) "
    "SELECT DATE(created_at), SUM(qty) FROM tb_order "
    "WHERE status = %s GROUP BY DATE(created_at)"
)


def run(conn):
    with conn.cursor() as cur:
        cur.execute(INSERT_SQL, ('DONE',))
        cur.execute("DELETE FROM tb_order WHERE status = 'CANCEL'")
    conn.commit()


if __name__ == '__main__':
    run(pymysql.connect(host='db', user='shop', db='shop'))
