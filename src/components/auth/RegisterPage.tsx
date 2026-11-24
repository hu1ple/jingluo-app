/**
 * 注册页（W1-B 前半，Issue #487）—— 纯展示 + 本地校验，**不认识 store、不发请求**。
 *
 * 两个字段由服务端开关决定出不出现（#484 §3.1c / §3.1d：「客户端所有『入口是否显示』都由
 * `settings/public` 决定，本地不写死」）：
 *  - `emailVerifyEnabled` → 验证码行 + 「发送验证码」按钮（服务端 `/auth/send-verify-code`，5/min）；
 *  - `invitationCodeEnabled` → 邀请码行（**可选**：邀请关系只能在注册时填一次，#484 §3.1b）。
 *
 * 冷却秒数「不写死文案里的数字」：提示句是 `sub2authCodeSent`，`{seconds}` 由这里的倒计时注入。
 * 服务端限流是 5/min，所以本地冷却取 60s（服务端仍然说了算 —— 早发只会拿回 rate_limited）。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AuthFlags } from '../../services/auth/flags.js'
import type { AuthError } from '../../services/auth/types.js'
import { Button } from '../base/Button.js'
import { IconToastError16 } from '../base/icons.js'
import {
  isValidEmail,
  issueMessageKey,
  validateRegister,
  type AuthIssue,
  type RegisterValues,
} from './authForm.js'
import {
  isRateLimited,
  rateLimitSecondsOf,
  releaseWhenSettled,
  tickCooldown,
  type SendCodeOutcome,
} from './submitGuard.js'
import styles from './AuthPages.module.css'

/** 服务端发码限流 5/min → 本地冷却 60s（只影响按钮可用时间，不改服务端判定） */
const CODE_COOLDOWN_SECONDS = 60

/** 这一轮倒计时是哪来的：真发出去了 / 被 429 挡回来（两种话不能说错，见下方两处提示） */
type CooldownReason = 'sent' | 'limited'

export type RegisterPageProps = {
  /** 嵌进「账号」面板时的形态（#608）：与 `LoginPage` 的 `embedded` 同一口径 */
  embedded?: boolean
  /** `settings/public` 的三开关：邮箱验证 / 邀请码两行由它控制显隐 */
  flags: AuthFlags
  busy: boolean
  sendingCode: boolean
  error: AuthError | null
  /**
   * 提交注册。返回值可以（也建议）是请求的 promise：页面用它把 ref 闩**held 到请求结束**
   * （只按同一 tick 释放的话，第二次点击就靠 `busy` 接力，慢一帧就又漏一次）。
   */
  onSubmit: (values: RegisterValues) => unknown
  /** 发码：`ok` 之外还要能说「被限流了多久」（429 是可等待，不是失败） */
  onSendCode: (email: string) => Promise<SendCodeOutcome>
  onSwitchToLogin: () => void
}

export const RegisterPage = ({
  embedded = false,
  flags,
  busy,
  sendingCode,
  error,
  onSubmit,
  onSendCode,
  onSwitchToLogin,
}: RegisterPageProps) => {
  const t = useTranslate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [issues, setIssues] = useState<AuthIssue[]>([])
  const [cooldown, setCooldown] = useState(0)
  /** 这一轮倒计时为什么起（`limited` = 429 挡回来的，话不能说是「已发送」） */
  const [cooldownReason, setCooldownReason] = useState<CooldownReason>('sent')
  /** 提交被 429 挡回来之后的冷却秒数（>0 = 主按钮禁用 + 显示剩余秒数） */
  const [submitCooldown, setSubmitCooldown] = useState(0)
  /**
   * 提交闩（事故核心）：`busy` 是 state，同一 tick 连点两次会都读到旧值、两次都放行
   * —— 与 `AppUpdateField` 那个坑同源，只有 ref 挡得住。state 仍然负责置灰与 `aria-busy`。
   */
  const submitInFlight = useRef(false)
  /** 发码闩：`sendingCode` 同样是 state，同上（冷却只覆盖「已经成功发出去」之后，挡不住同 tick） */
  const sendInFlight = useRef(false)

  // 倒计时：只用 setTimeout 逐秒减，组件卸载即清；不做 setInterval（避免前后台切换后的漂移）
  useEffect(() => {
    if (cooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setCooldown(tickCooldown), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  // 提交链路的 429 冷却：同一个逐秒 setTimeout 口径
  useEffect(() => {
    if (submitCooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setSubmitCooldown(tickCooldown), 1000)
    return () => window.clearTimeout(timer)
  }, [submitCooldown])

  // 提交撞 429（`error` 由 store 归一后传进来）：按 `Retry-After` 起冷却，没有该头就 60s。
  // 提交流程自己拿不到 header，秒数只能从这里来（见 `submitGuard.ts` 文件头第 2 条）。
  useEffect(() => {
    const seconds = rateLimitSecondsOf(error)
    if (seconds !== null) {
      setSubmitCooldown((left) => Math.max(left, seconds))
    }
  }, [error])

  const issueOf = (field: AuthIssue['field']): AuthIssue | undefined =>
    issues.find((item) => item.field === field)
  const clearIssue = () => {
    if (issues.length > 0) {
      setIssues([])
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || submitInFlight.current || submitCooldown > 0) {
      return
    }
    const found = validateRegister({ email, password, confirmPassword, verifyCode, invitationCode })
    setIssues(found)
    if (found.length > 0) {
      return
    }
    // 抢闩 → 发请求 → 结束时释放。`finally` 的语义用 promise 的两个分支表达（不是抛错流），
    // 所以请求失败（包括 429）同样会释放，下一次点击照常能发。
    submitInFlight.current = true
    const release = () => {
      submitInFlight.current = false
    }
    try {
      const pending: unknown = onSubmit({
        email: email.trim(),
        password,
        confirmPassword,
        verifyCode: flags.emailVerifyEnabled ? verifyCode.trim() : undefined,
        // 邀请码是可选的：空串不传，免得服务端把 "" 当成一个无效邀请码
        invitationCode:
          flags.invitationCodeEnabled && invitationCode.trim() !== ''
            ? invitationCode.trim()
            : undefined,
      })
      // 父层（AuthGate → store）返回 promise 时闩 held 到请求结束；返回 void 时立刻释放，
      // 交给 `busy` 接力（两条路都比「只靠 state」严格）。
      releaseWhenSettled(pending, release)
    } catch (error) {
      release()
      throw error
    }
  }

  const sendCode = async () => {
    if (sendingCode || cooldown > 0 || sendInFlight.current) {
      return
    }
    if (!isValidEmail(email)) {
      setIssues([{ field: 'email', reason: email.trim() === '' ? 'required' : 'email_format' }])
      return
    }
    sendInFlight.current = true
    try {
      const outcome = await onSendCode(email.trim())
      if (outcome.ok) {
        setCooldownReason('sent')
        setCooldown(CODE_COOLDOWN_SECONDS)
        return
      }
      if (outcome.retryAfterSeconds !== undefined) {
        // 429：不是「失败」，是「太频繁」—— 按服务端秒数进冷却，期间按钮禁用
        setCooldownReason('limited')
        setCooldown(outcome.retryAfterSeconds)
      }
    } finally {
      sendInFlight.current = false
    }
  }

  const emailIssue = issueOf('email')
  const emailMessageKey = emailIssue ? issueMessageKey(emailIssue) : null
  const passwordIssue = issueOf('password')
  const confirmIssue = issueOf('confirmPassword')
  const codeIssue = issueOf('verifyCode')
  const codeButtonDisabled = busy || sendingCode || cooldown > 0
  /** 发码那一路正在 429 冷却里（提示换一句话，不能说是「已发送」） */
  const codeLimited = cooldown > 0 && cooldownReason === 'limited'
  const submitDisabled = busy || submitCooldown > 0

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t('sub2authRegister')}</h1>

        {/*
          429 冷却期间**不显示** `error.messageKey`：store 把 429 归一成 `sub2authLoginFailed`
          （「登录失败，请重试」），而这一刻的真相是「太频繁，等 N 秒」—— 两句话同时在屏幕上，
          用户会以为是自己填错了。冷却结束、`error` 还是那句失败文案时照常显示。
        */}
        {error && !isRateLimited(error) && submitCooldown <= 0 ? (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              <IconToastError16 />
            </span>
            <span>{t(error.messageKey)}</span>
          </div>
        ) : null}

        {/* 发码那一路已经就地显示同一句话（`codeLimited`），这里不重复；但主按钮照样禁用 —— */}
        {/* 服务端限流是**按 IP** 的，发码被限时提交也一定还是 429（事故现场就是这个形态） */}
        {submitCooldown > 0 && !codeLimited ? (
          <p className={styles.hint} role="status" data-testid="register-rate-limited">
            {t('sub2authTooManyTries', { seconds: submitCooldown })}
          </p>
        ) : null}

        <form className={styles.form} onSubmit={submit} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authEmail')}</span>
            <input
              className={emailIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="email"
              name="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              value={email}
              aria-invalid={emailIssue ? true : undefined}
              onChange={(event) => {
                setEmail(event.target.value)
                clearIssue()
              }}
            />
            {emailMessageKey ? (
              <span className={styles.fieldError} role="alert">
                {t(emailMessageKey)}
              </span>
            ) : null}
          </label>

          {flags.emailVerifyEnabled ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="auth-verify-code">
                {t('oursEmailCodePlaceholder')}
              </label>
              <div className={styles.codeRow}>
                <input
                  id="auth-verify-code"
                  className={codeIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                  type="text"
                  name="verifyCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={verifyCode}
                  aria-invalid={codeIssue ? true : undefined}
                  onChange={(event) => {
                    setVerifyCode(event.target.value)
                    clearIssue()
                  }}
                />
                <Button
                  variant="outlined"
                  size="l"
                  className={styles.codeButton}
                  disabled={codeButtonDisabled}
                  aria-busy={sendingCode}
                  onClick={() => {
                    void sendCode()
                  }}
                >
                  {t('sub2authSendCode')}
                </Button>
              </div>
              {cooldown > 0 ? (
                <span className={styles.hint} role="status">
                  {codeLimited
                    ? t('sub2authTooManyTries', { seconds: cooldown })
                    : t('sub2authCodeSent', { seconds: cooldown })}
                </span>
              ) : null}
            </div>
          ) : null}

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authPassword')}</span>
            <input
              className={passwordIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              aria-invalid={passwordIssue ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value)
                clearIssue()
              }}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authConfirmPassword')}</span>
            <input
              className={confirmIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              aria-invalid={confirmIssue ? true : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value)
                clearIssue()
              }}
            />
          </label>

          {flags.invitationCodeEnabled ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('inviteCode')}</span>
              <input
                className={styles.input}
                type="text"
                name="invitationCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={invitationCode}
                onChange={(event) => setInvitationCode(event.target.value)}
              />
              <span className={styles.hint}>{t('inviteCodeAtRegister')}</span>
            </label>
          ) : null}

          <div className={styles.actions}>
            <Button
              type="submit"
              variant="primary"
              size="l"
              block
              disabled={submitDisabled}
              aria-busy={busy}
              testId="register-submit"
            >
              <span className={styles.submit}>
                {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {t('sub2authRegister')}
              </span>
            </Button>
          </div>
        </form>

        <div className={styles.switchRow}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={onSwitchToLogin}
            disabled={busy}
          >
            {t('sub2authLogin')}
          </button>
        </div>
      </div>
    </div>
  )
}
