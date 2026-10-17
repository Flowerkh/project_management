#!/bin/sh
# 일 정산 배치: 전날 결제 완료 주문을 판매자별로 정산
. /app/batch/common/env.sh
LOG=/app/logs/settle_$(date +%Y%m%d).log
sqlplus -s $DB_USER/$DB_PASS@SHOP @/app/batch/sql/settle_daily.sql >> $LOG
