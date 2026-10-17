#!/bin/sh
# 로그 정리: 30일 지난 로그 삭제
find /app/logs -name "*.log" -mtime +30 -delete
