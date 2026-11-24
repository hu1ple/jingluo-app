-- 邮件通道：**本地 sink**（离线联调用，`reset-pre.sh --mail-sink`）
-- 好处：不打扰真实邮箱、能在磁盘上断言"信真的发出去了"；
-- 代价：用户收不到验证码 —— 只适合自动化测试，不适合人工验收。
BEGIN;
INSERT INTO settings (key,value,updated_at) VALUES
  ('smtp_host','127.0.0.1',now()), ('smtp_port','1025',now()),
  ('smtp_username','',now()),      ('smtp_password','',now()),
  ('smtp_from','verify@notify.nekoai.com.cn',now()),
  ('smtp_from_name','鲸落(预发布)',now()), ('smtp_use_tls','false',now())
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();
UPDATE settings SET value='false', updated_at=now() WHERE key IN ('ses_enabled','aliyun_dm_enabled');
UPDATE settings SET value='',      updated_at=now() WHERE key='email_verify_provider';
COMMIT;
