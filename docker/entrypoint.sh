#!/bin/sh
# 容器启动顺序：迁移 → 种子 → 服务。
# 迁移自带重试：外部库可能比容器晚就绪。
set -e

# 容器内的 localhost 是容器自己，不是宿主机。开发用的 .env 通常写 localhost，
# 原样带进来必然连不上，这里按显式规则改写并打出日志，避免一个看不懂的连接错误。
case "$DATABASE_URL" in
  *@localhost:* | *@127.0.0.1:*)
    DATABASE_URL=$(printf '%s' "$DATABASE_URL" |
      sed -e 's/@localhost:/@host.docker.internal:/' -e 's/@127\.0\.0\.1:/@host.docker.internal:/')
    export DATABASE_URL
    echo "[docker] DATABASE_URL 指向 localhost，已在容器内改写为 host.docker.internal"
    ;;
esac

attempt=0
max_attempts=30
until pnpm --filter @dblab/db migrate; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "[docker] 迁移重试 $max_attempts 次仍未成功，请检查 DATABASE_URL 与库的网络可达性" >&2
    exit 1
  fi
  echo "[docker] 迁移失败，2 秒后重试（$attempt/$max_attempts）"
  sleep 2
done

echo "[docker] 确保初始管理员存在"
pnpm --filter @dblab/db seed

echo "[docker] 启动服务"
exec pnpm --filter @dblab/server start
