set -euo pipefail
P="/usr/bin/psql"; D=/var/lib/postgresql/tmp; F=$D/settings.csv; rm -f $F
sudo -u postgres $P -d sub2api_staging -c "\copy (select key, value from settings order by key) to '$F' with (format csv, delimiter '|')" >/dev/null
sudo -u postgres chown postgres:postgres $F
python3 - "$F" <<'PY'
import sys, csv
SECRET = {'admin_api_key','aliyun_dm_access_key_id','aliyun_dm_access_key_secret','ses_secret_id','ses_secret_key'}
rows=[]
with open(sys.argv[1], newline='', encoding='utf-8') as fh:
    for r in csv.reader(fh, delimiter='|'):
        if len(r) < 2: continue
        k, v = r[0], '|'.join(r[1:])
        if k in SECRET: continue
        rows.append((k, v))
print('-- sub2api 预发布种子配置（非敏感）')
print('-- 由 scripts/gen-sub2api-seed.sh 从生产库生成；敏感项见 seed.local.env.example')
print('-- 幂等：全部 ON CONFLICT DO UPDATE，可反复执行')
print('BEGIN;')
for k, v in rows:
    val = v.replace('$seed$', '$seed_$')
    print(f"INSERT INTO settings (key, value, updated_at) VALUES ('{k}', $seed${val}$seed$, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();")
print("INSERT INTO groups (id, name, description, rate_multiplier, is_exclusive, status, created_at, updated_at) VALUES (1, 'default', '默认分组（预发布基线）', 1.0000, false, 'active', now(), now()) ON CONFLICT (id) DO NOTHING;")
print('COMMIT;')
print(f'-- 共 {len(rows)} 条 settings + 1 条 group', file=sys.stderr)
PY
rm -f $F
