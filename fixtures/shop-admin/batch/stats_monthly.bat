@echo off
REM 월 매출 집계: 매월 1일 01:00 (작업 스케줄러)
sqlplus -s %DB_USER%/%DB_PASS%@SHOP @batch\sql\stats_monthly.sql
