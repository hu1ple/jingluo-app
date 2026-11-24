#!/usr/bin/env bash
# =============================================================================
# reset-pre.sh —— 重置 sub2api 预发布环境（140 上执行；**永不触碰生产**）
#
#   ./reset-pre.sh --with-seed     # 重建库 + 灌 seed.sql + 灌 seed.local.env 的秘密 → 完整基线
#   ./reset-pre.sh --data-only     # 只清用户数据，保留配置（日常回归用这个）
#   ./reset-pre.sh --no-backup     # 跳过备份（默认一定先备份）
#
# 为什么需要它：预发布库是「空库 + 迁移默认值」，而运营配置（送多少额度、默认分组、
# 收款页地址、功能开关）**全在 settings 表**里，不在代码里。新起一个库必须把配置播种回去，
# 否则就是「代码一致、行为不一致」——第一次踩这个坑是 default_balance 没灌，新用户额度为 0。
#
# 硬约束（脚本自己守着，不靠人记）：
#   · 目标库写死 sub2api_pre；出现 sub2api_staging / sub2api 直接中止
#   · 只 restart sub2api-pre.service，绝不 restart / reload sub2api-staging
#   · 任何破坏性动作之前先 pg_dump 备份到 /opt/dev/backup/
# =============================================================================
set -euo pipefail

DB=sub2api_pre
DB_OWNER=sub2api_pre
SVC=sub2api-pre
DIR=/opt/sub2api-pre
BACKUP_DIR=/opt/dev/backup
API=http://127.0.0.1:16100
PSQL=/usr/bin/psql

WITH_SEED=0
DATA_ONLY=0
DO_BACKUP=1

for a in "$@"; do
  case "$a" in
    --with-seed) WITH_SEED=1 ;;
    --data-only) DATA_ONLY=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "[reset-pre] 未知参数: $a" >&2; exit 2 ;;
  esac
done
[ "$DATA_ONLY" = 1 ] && [ "$WITH_SEED" = 1 ] && { echo "[reset-pre] --data-only 与 --with-seed 不能同时用" >&2; exit 2; }
[ "$DATA_ONLY" = 0 ] && [ "$WITH_SEED" = 0 ] && WITH_SEED=1   # 默认走完整基线

log(){ printf '\n\033[1;36m[reset-pre] %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31m[reset-pre][ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 安全闸
[ "$DB" = "sub2api_pre" ] || die "目标库必须是 sub2api_pre（当前 $DB）"
case "$DB" in *staging*|*prod*) die "拒绝操作 $DB（疑似生产库）" ;; esac
[ "$(id -u)" = 0 ] || die "需要 root（要 dropdb / systemctl）"
command -v psql >/dev/null || die "找不到 psql"

# ---------------------------------------------------------------- 1. 备份
if [ "$DO_BACKUP" = 1 ]; then
  log "1/6 备份当前 $DB"
  mkdir -p "$BACKUP_DIR"
  if sudo -u postgres "$PSQL" -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1; then
    OUT="$BACKUP_DIR/${DB}-$(date +%Y%m%d-%H%M%S).sql.gz"
    sudo -u postgres pg_dump "$DB" | gzip > "$OUT"
    echo "  已备份 → $OUT（$(du -h "$OUT" | cut -f1)）"
  else
    echo "  库还不存在，跳过备份"
  fi
else
  log "1/6 跳过备份（--no-backup）"
fi

# ---------------------------------------------------------------- 2. 重建 / 清数据
if [ "$DATA_ONLY" = 1 ]; then
  log "2/6 只清用户数据（保留 settings 配置）"
  sudo -u postgres "$PSQL" -d "$DB" -c "TRUNCATE users CASCADE" >/dev/null
  echo "  已清空 users（级联清 api_keys / orders / sessions 等）"
else
  log "2/6 重建库 $DB（drop → create → 由服务启动时跑迁移）"
  # 必须先停服务：它在跑的时候会立刻重连，DROP DATABASE 会报
  # `database is being accessed by other users`（实测踩到）。
  systemctl stop "$SVC" || true
  sudo -u postgres "$PSQL" -tAc "select pg_terminate_backend(pid) from pg_stat_activity where datname='$DB' and pid <> pg_backend_pid()" >/dev/null
  sudo -u postgres "$PSQL" -c "DROP DATABASE IF EXISTS $DB" >/dev/null
  sudo -u postgres "$PSQL" -c "CREATE DATABASE $DB OWNER $DB_OWNER" >/dev/null
  echo "  已重建，属主 $DB_OWNER"
fi

# ---------------------------------------------------------------- 3. 重启预发布（跑迁移 / 清 30s 配置缓存）
log "3/6 重启 $SVC（不碰 sub2api-staging）"
systemctl restart "$SVC"
for i in $(seq 1 30); do
  sleep 1
  curl -sf -m 2 "$API/health" >/dev/null 2>&1 && break
done
curl -sf -m 3 "$API/health" >/dev/null || die "重启后 /health 不通，看 journalctl -u $SVC -n 50"
# /health 可能先于迁移就绪（踩过：紧接着灌种子时 `relation "accounts" does not exist`）。
# 所以还要等**表真的建出来**，否则后面的 seed 会打在空库上。
for i in $(seq 1 60); do
  n=$(sudo -u postgres "$PSQL" -d "$DB" -tAc "select count(*) from information_schema.tables where table_schema='public' and table_name='accounts'" 2>/dev/null | tr -d ' ')
  [ "${n:-0}" -ge 1 ] && break
  sleep 1
done
[ "${n:-0}" -ge 1 ] || die "等了 60s，迁移还没建出 accounts 表（看 journalctl -u $SVC -n 80）"
echo "  $SVC 已就绪（迁移完成，表数 $(sudo -u postgres "$PSQL" -d "$DB" -tAc "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' ')）"

# ---------------------------------------------------------------- 4. 灌种子配置
if [ "$WITH_SEED" = 1 ]; then
  log "4/6 灌 seed.sql（非敏感业务配置）"
  [ -f "$DIR/seed.sql" ] || die "找不到 $DIR/seed.sql"
  sudo -u postgres "$PSQL" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$DIR/seed.sql" >/dev/null
  echo "  已灌 $(grep -c 'INSERT INTO settings' "$DIR/seed.sql") 条 settings + 默认分组"

  # 上游账号 + 渠道 + 模型定价（含凭据 → 本机 600，不进 git）。
  # 没有它，网关会回 503 `No available accounts`（聊天完全不可用）。
  if [ -f "$DIR/seed.upstream.local.sql" ]; then
    sudo -u postgres "$PSQL" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$DIR/seed.upstream.local.sql" >/dev/null
    echo "  已灌 seed.upstream.local.sql（上游账号 / 渠道 / 模型定价 → 聊天可用）"
  else
    echo "  ⚠ 没有 $DIR/seed.upstream.local.sql：预发布将无法聊天（503 no available accounts）"
  fi

  # 预发布专用覆盖（邮件通道指向本机 sink、打开验证码式密码重置）
  if [ -f "$DIR/seed.pre.sql" ]; then
    sudo -u postgres "$PSQL" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$DIR/seed.pre.sql" >/dev/null
    echo "  已灌 seed.pre.sql（password_reset_enabled=true，邮件走本机 mail-sink）"
  fi

  if [ -f "$DIR/seed.local.env" ]; then
    log "    灌 seed.local.env（秘密项）"
    # 只取有值的键；settings key = 大写环境变量名的小写形式（ADMIN_API_KEY → admin_api_key）
    ( set -a; . "$DIR/seed.local.env"; set +a
      python3 - "$DB" <<'PY'
import os, subprocess, sys
mapping = {
    'ADMIN_API_KEY': 'admin_api_key',
    'ALIYUN_DM_ACCESS_KEY_ID': 'aliyun_dm_access_key_id',
    'ALIYUN_DM_ACCESS_KEY_SECRET': 'aliyun_dm_access_key_secret',
    'SES_SECRET_ID': 'ses_secret_id',
    'SES_SECRET_KEY': 'ses_secret_key',
}
stmts = []
for env, key in mapping.items():
    v = (os.environ.get(env) or '').strip()
    if v:
        stmts.append(f"INSERT INTO settings (key,value,updated_at) VALUES ('{key}', $v${v}$v$, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();")
if stmts:
    subprocess.run(['sudo','-u','postgres','/usr/bin/psql','-d',sys.argv[1],'-v','ON_ERROR_STOP=1','-q','-c','\n'.join(stmts)], check=True)
print(f'    写入 {len(stmts)} 条秘密项')
PY
    )
  else
    echo "  没有 $DIR/seed.local.env，跳过秘密项（发信 / 管理 API 不可用）"
  fi
else
  log "4/6 跳过种子（--data-only）"
fi

# ---------------------------------------------------------------- 5. 等配置缓存过期
log "5/6 等待配置缓存刷新（30s 以内的进程内缓存）"
sleep 4

# ---------------------------------------------------------------- 6. 自检
log "6/6 自检"
fail=0
chk(){ printf '  %-34s ' "$1"; if eval "$2" >/dev/null 2>&1; then echo "OK"; else echo "FAIL"; fail=1; fi; }
chk "/health" "curl -sf -m 3 $API/health"
chk "/api/v1/settings/public" "curl -sf -m 3 $API/api/v1/settings/public"
chk "pay-link 已配置" "curl -sf -m 3 $API/api/v1/pay-link | grep -q '\"ok\":true'"
chk "CORS 预检放行" "curl -sf -m 3 -X OPTIONS -H 'Origin: http://localhost' -H 'Access-Control-Request-Method: GET' $API/api/v1/payment/orders/my"
if [ "$WITH_SEED" = 1 ]; then
  printf '  %-34s ' "default_balance 已播种"
  v=$(sudo -u postgres "$PSQL" -d "$DB" -tAc "select value from settings where key='default_balance'" | tr -d ' ')
  [ -n "$v" ] && echo "OK（$v）" || { echo "FAIL"; fail=1; }
  printf '  %-34s ' "password_reset_enabled"
  v=$(sudo -u postgres "$PSQL" -d "$DB" -tAc "select value from settings where key='password_reset_enabled'" | tr -d ' ')
  [ "$v" = "true" ] && echo "OK" || { echo "FAIL（$v）"; fail=1; }
  printf '  %-34s ' "忘记密码可用（验证码模式）"
  if curl -sf -m 3 -X POST "$API/api/v1/auth/forgot-password" -H 'content-type: application/json' \
       -d '{"email":"nobody@example.invalid"}' | grep -q verification; then
    echo "OK"
  else
    echo "FAIL"; fail=1
  fi
  printf '  %-34s ' "上游账号已播种"
  n=$(sudo -u postgres "$PSQL" -d "$DB" -tAc "select count(*) from accounts where status='active' and schedulable" | tr -d ' ')
  [ "${n:-0}" -gt 0 ] && echo "OK（$n 个可调度）" || { echo "FAIL（0 个，聊天会 503）"; fail=1; }
  printf '  %-34s ' "默认分组平台 = openai"
  v=$(sudo -u postgres "$PSQL" -d "$DB" -tAc "select platform from groups where id=1" | tr -d ' ')
  [ "$v" = "openai" ] && echo "OK" || { echo "FAIL（$v，账号选不到）"; fail=1; }
  printf '  %-34s ' "mail-sink 在跑"
  systemctl is-active mail-sink >/dev/null 2>&1 && echo "OK" || echo "未启动（验证码邮件无处可去）"
fi
printf '  %-34s ' "生产实例未被重启"
t=$(systemctl show -p ActiveEnterTimestamp --value sub2api-staging)
echo "OK（启动于 $t）"

[ "$fail" = 0 ] && echo "\n[reset-pre] 完成 ✅" || { echo "\n[reset-pre] 自检有失败项 ❌" >&2; exit 1; }
