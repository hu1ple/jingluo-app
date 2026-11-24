/**
 * 登录页（W1-B 前半，Issue #487）—— 纯展示 + 本地校验，**不认识 store、不发请求**。
 *
 * 为什么把它做成受控组件：AuthGate 负责把 store 的动作接上来，截图脚本 / 后续「换账号」弹层
 * 也能单独渲染这一页并摆出「提交中 / 错误」两种状态（#487 的 390/360 两档截图就是这么来的）。
 *
 * 文案全部走 i18n（已合并的 `sub2auth*`）：标题、字段名、按钮、错误条都取 key，本文件里
 * 没有一句手写中文；错误条的 key 来自 `error.messageKey`（传输层归一结果），页面不自己判断错误类型。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { AuthError } from '../../services/auth/types.js'
import { Button } from '../base/Button.js'
import { IconToastError16 } from '../base/icons.js'
import { issueMessageKey, validateLogin, type AuthIssue, type LoginValues } from './authForm.js'
import { isRateLimited, rateLimitSecondsOf, releaseWhenSettled, tickCooldown } from './submitGuard.js'
import styles from './AuthPages.module.css'

export type LoginPageProps = {
  /**
   * 嵌进「账号」面板时的形态（#608）：不再占满一屏（`min-height: 100vh` 会把它撑出宿主弹层），
   * 只留卡片本身。表单、校验、文案与整屏形态**完全同一份**。
   */
  embedded?: boolean
  /** 注册入口是否显示：由 `settings/public` 的 `registration_enabled` 决定（false 时整块隐藏，#484 §3.1d） */
  showRegisterEntry: boolean
  /** 提交中：按钮置灰 + aria-busy，表单其余部分保持可见（不要闪成另一种布局） */
  busy: boolean
  /** 上一次提交的失败（归一结果，`messageKey` 就是上屏文案） */
  error: AuthError | null
  /**
   * 进门就先说明的一句提示（还没有 `error` 时用）：`expired` = 登录已过期，需要重新登录。
   * 与 `error` 分开：提示不是「你填错了」，样式也不该是错误条那样抢眼。
   */
  noticeKey?: TranslationKey | null
  /**
   * 提交登录。返回值可以是请求的 promise：页面用它把 ref 闩 held 到请求结束
   * （连点两次的下场就是服务端 IP 限流，之后连正确密码都会被 429 挡住）。
   */
  onSubmit: (values: LoginValues) => unknown
  onSwitchToRegister: () => void
  /**
   * 「忘记密码」→ 找回密码页（`ResetPasswordPage`，同一张卡内换页，不新开弹层）。
   *
   * 为什么入口在这里：忘记密码的人**往往正站在这张表单前**，从别处绕过去他找不到。
   * 显隐**不受** `registration_enabled` 影响 —— 这个开关管注册，不管「已有账号的人能不能回来」。
   */
  onSwitchToForgot: () => void
}

export const LoginPage = ({
  embedded = false,
  showRegisterEntry,
  busy,
  error,
  noticeKey = null,
  onSubmit,
  onSwitchToRegister,
  onSwitchToForgot,
}: LoginPageProps) => {
  const t = useTranslate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [issues, setIssues] = useState<AuthIssue[]>([])
  /** 登录被 429 挡回来之后的冷却秒数（>0 = 主按钮禁用 + 显示「请 N 秒后再试」） */
  const [submitCooldown, setSubmitCooldown] = useState(0)
  /**
   * 提交闩：`busy` 是 state，同一 tick 连点两次会都读到旧值、两次都放行
   * （`AppUpdateField` 文件里记过同一个坑）。state 仍负责置灰与 `aria-busy`。
   */
  const inFlight = useRef(false)

  // 429 冷却的逐秒倒计时（与 RegisterPage 同口径：setTimeout，不 setInterval）
  useEffect(() => {
    if (submitCooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setSubmitCooldown(tickCooldown), 1000)
    return () => window.clearTimeout(timer)
  }, [submitCooldown])

  // 429（`error` 由 store 归一后传进来）：按 `Retry-After` 起冷却，没有该头就 60s
  useEffect(() => {
    const seconds = rateLimitSecondsOf(error)
    if (seconds !== null) {
      setSubmitCooldown((left) => Math.max(left, seconds))
    }
  }, [error])

  const issueOf = (field: AuthIssue['field']): AuthIssue | undefined =>
    issues.find((issue) => issue.field === field)

  // 本地校验只拦「明显发不出去」的：邮箱格式 / 空密码（密码长度交给服务端，老账号短密码也要能登进来）
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || inFlight.current || submitCooldown > 0) {
      return
    }
    const found = validateLogin({ email, password })
    setIssues(found)
    if (found.length > 0) {
      return
    }
    inFlight.current = true
    const release = () => {
      inFlight.current = false
    }
    try {
      const pending: unknown = onSubmit({ email: email.trim(), password })
      releaseWhenSettled(pending, release)
    } catch (error) {
      release()
      throw error
    }
  }

  const emailIssue = issueOf('email')
  const emailMessageKey = emailIssue ? issueMessageKey(emailIssue) : null
  const passwordIssue = issueOf('password')

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t('sub2authLogin')}</h1>

        {noticeKey !== null && error === null ? (
          <div className={styles.notice} role="status" data-testid="auth-notice">
            {t(noticeKey)}
          </div>
        ) : null}

        {/*
          冷却期间**不显示** `error.messageKey`：429 被 store 归一成「登录失败，请重试」，
          而这一刻的真相是「太频繁，等 N 秒」—— 两句话同时出现会让人以为自己密码错了。
        */}
        {error && !isRateLimited(error) && submitCooldown <= 0 ? (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              <IconToastError16 />
            </span>
            <span>{t(error.messageKey)}</span>
          </div>
        ) : null}

        {submitCooldown > 0 ? (
          <p className={styles.hint} role="status" data-testid="login-rate-limited">
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
                if (issues.length > 0) {
                  setIssues([])
                }
              }}
            />
            {emailMessageKey ? (
              <span className={styles.fieldError} role="alert">
                {t(emailMessageKey)}
              </span>
            ) : null}
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authPassword')}</span>
            <input
              className={passwordIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={passwordIssue ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value)
                if (issues.length > 0) {
                  setIssues([])
                }
              }}
            />
          </label>

          <div className={styles.actions}>
            <Button
              type="submit"
              variant="primary"
              size="l"
              block
              disabled={busy || submitCooldown > 0}
              aria-busy={busy}
              testId="login-submit"
            >
              <span className={styles.submit}>
                {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {t('sub2authLogin')}
              </span>
            </Button>
          </div>
        </form>

        {showRegisterEntry ? (
          <div className={styles.switchRow}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={onSwitchToRegister}
              disabled={busy}
            >
              {t('sub2authRegister')}
            </button>
          </div>
        ) : null}

        {/*
          「忘记密码」单独一行、**用另一个类名**（`forgotRow` 而不是 `switchRow`）：分段控件那条
          `.segmented ~ * .switchRow { display: none }` 收掉的是「重复的注册入口」，不能顺手把
          「进不去账号时唯一的出路」也收掉。
        */}
        <div className={styles.forgotRow}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={onSwitchToForgot}
            disabled={busy}
            data-testid="auth-forgot-password"
          >
            {t('sub2authForgotPassword')}
          </button>
        </div>
      </div>
    </div>
  )
}
