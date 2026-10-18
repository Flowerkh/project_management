import cx_Oracle


def get_conn():
    return cx_Oracle.connect('scott/tiger@db:1521/ORCL')
