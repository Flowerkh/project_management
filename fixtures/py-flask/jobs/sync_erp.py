"""ERP 회원 동기화 - 매일 새벽 ERP 사용자 정보를 회원 테이블에 반영"""
import cx_Oracle  # noqa: F401

from jobs.common import get_conn

SELECT_ERP = "SELECT USER_ID, USER_NM, EMAIL FROM ERP_USER WHERE UPD_DT >= SYSDATE - 1"


def sync(conn):
    cur = conn.cursor()
    cur.execute(SELECT_ERP)
    for row in cur.fetchall():
        cur.execute("UPDATE TB_MEMBER SET NAME = :1 WHERE MEMBER_ID = :2", (row[1], row[0]))
    conn.commit()


if __name__ == '__main__':
    sync(get_conn())
