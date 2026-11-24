-- 邮件通道：**真发**（阿里云 DirectMail）—— 预发布默认用这个
-- 「预发布要能模拟真实环境」：验证码必须真的进用户邮箱，否则注册/忘记密码一律白测。
BEGIN;
UPDATE settings SET value='aliyun', updated_at=now() WHERE key='email_verify_provider';
UPDATE settings SET value='true',   updated_at=now() WHERE key='aliyun_dm_enabled';
UPDATE settings SET value='false',  updated_at=now() WHERE key='ses_enabled';
COMMIT;
