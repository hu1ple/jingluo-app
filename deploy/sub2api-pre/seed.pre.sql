-- 预发布专用覆盖（在 seed.sql 之后执行；可反复重放）
--
-- 为什么单独一份：seed.sql 是从**生产**导出的业务基线（额度/分组/收款页/开关），
-- 而这几项是「预发布环境特有」的 —— 生产不能照抄，否则会把生产改成联调配置。
--
-- 邮件通道刻意指向本机 mail-sink（systemd: mail-sink.service，监听 127.0.0.1:1025，
-- 把每封信落成 /opt/sub2api-pre/mailbox/*.eml）：联调期间**不打扰真实邮箱**，
-- 也能在测试里断言「信真的发出去了」。真要用阿里云 DM 发真信，把下面三段注释掉，
-- 把 ses_enabled / aliyun_dm_enabled 置回 true、email_verify_provider 置回 'aliyun'。

BEGIN;

-- 1) 忘记密码：验证码模式可用（App / 网页内闭环，不需要 frontend_url）
INSERT INTO settings (key, value, updated_at) VALUES ('password_reset_enabled', 'true', now())
  ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now();

-- 2/3) 邮件通道**不在这里**：真发还是本地 sink 由 `reset-pre.sh` 按参数应用
--      `seed.mail.real.sql` / `seed.mail.sink.sql`（预发布默认**真发**）。

-- 4) 默认分组的平台：迁移默认给的是 `anthropic`，而生产 group 1 是 `openai`。
--    不一致的后果是**静默 503**：账号的 platform 是 openai，分组却要 anthropic →
--    候选集永远为空 → 网关回 `No available accounts`（本次实测踩到，排查了半天）。
UPDATE groups SET platform = 'openai', updated_at = now() WHERE id = 1;

COMMIT;
