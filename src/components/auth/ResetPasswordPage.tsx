/**
 * 「找回密码」小页（**验证码式两步**）—— 纯展示 + 本地校验，**不认识 store、不写凭据**。
 *
 * ## 为什么是一页两步，而不是两个页面 / 一个弹层
 *
 * 产品要求「不新开弹层」：设置弹层里 `role="dialog"` 的数量不许变多（每叠一层，手机上就多一层
 * 遮罩、多一次返回键歧义）。所以第一步（邮箱 → 发送验证码）与第二步（验证码 + 新密码 + 确认）
 * 是**同一个组件里的 `step` 状态**：DOM 里始终只有一个卡片，切步骤不换容器、不新增 dialog。
 *
 * ## 三步纪律
 *  1. **不发请求的地方不装样子**：邮箱空 / 格式错、验证码不是 6 位数字、新密码 < 6 位、两次不一致
 *     全部**本地拦下**（一条请求都不发），提示就地飘在字段下面；
 *  2. **失败文案每种一句**（不许一律「失败」）：码错 / 码过期 → `settingsAuthResetCodeWrong`；
 *     密码太短 → `settingsAuthResetPasswordTooShort`；两次不一致 → `settingsAuthPasswordMismatch`；
 *     限流 / 网络 / 后端没开 → 各自的 key（见 `passwordReset.ts` 的 `*Failure` 联合类型）；
 *  3. **演示模式必须挂在脸上**：`passwordReset.ts` 降级成演示时会回 `demo: true`，这里立刻在
 *     标题下面挂一行「当前为演示模式，验证码固定 123456（不会发送真实邮件）」——
 *     不许让人以为真发了邮件（那是把人骗去等一封永远不来的信）。
 *
 * ## 成功之后说什么（口径来自 `consume/confirmEffect.ts` 的 `resetPassword` 那条）
 *
 * 匿名重置流程**没有可回查的会话**，接口也不回实体，所以「重置成功」只等于「服务端受理了」。
 * 界面因此**不写**「密码已修改」，只写「密码已重置，请用新密码登录」
 * （`authResetDonePleaseLogin`，由宿主 —— 设置卡的 `back-to-login` 事件或 `AuthGate` ——
 * 挂到**登录表单**的 notice 上）—— 真正的确认是用户自己用新密码登一次。
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  DEMO_CODE,
  MIN_RESET_PASSWORD_LENGTH,
  isValidResetCode,
  requestResetCode,
  resetPasswordDemoState,
  resetPasswordWithCode,
  type DemoReason,
  type RequestResetFailure,
  type ResetWithCodeFailure,
} from '../../services/auth/passwordReset.js'
import { Button } from '../base/Button.js'
import { IconToastError16 } from '../base/icons.js'
import { isValidEmail } from './authForm.js'
import { RATE_LIMIT_FALLBACK_SECONDS, tickCooldown } from './submitGuard.js'
import styles from './AuthPages.module.css'

/** 服务端发码限流 5/min → 本地冷却 60s（只影响重发按钮可用时间，服务端仍然说了算） */
const CODE_COOLDOWN_SECONDS = 60

/** 出问题的字段（本地校验只标红框 + 就地一句提示，不阻止用户继续改） */
type ResetField = 'email' | 'code' | 'password' | 'confirm'

/** 这一轮发码倒计时是哪来的：真发出去了 / 被 429 挡回来（后者不能说「已发送」） */
type CooldownReason = 'sent' | 'limited'

type FieldIssue = { field: ResetField; key: TranslationKey }

export type ResetPasswordPageProps = {
  /** 嵌进「账号」面板时的形态（与 `LoginPage` / `RegisterPage` 同一口径） */
  embedded?: boolean
  /**
   * 进页时带上的邮箱（可选）。宿主刚在登录表单里打过邮箱时，没理由让用户再打一遍 ——
   * 但**仍然可改**：忘记密码的人常常记不清当时注册的是哪个邮箱。
   */
  initialEmail?: string
  /** 左上「‹ 返回登录」：切回登录页（**不是**关弹层，弹层归宿主） */
  onBack: () => void
  /**
   * 两步都走完（服务端受理了重置）。**带上这次用的邮箱**：宿主据此回**登录表单**并预填它 ——
   * 重置页里的邮箱用户可能改过（忘记密码的人常常记不清注册邮箱），所以不能沿用表单里的旧值。
   */
  onReset: (email: string) => void
}

/** 发码失败 → 上屏文案（每种一句，不合并） */
const requestFailureKey = (reason: RequestResetFailure): TranslationKey => {
  if (reason === 'not-enabled') {
    // 降级演示时走不到这里（`passwordReset.ts` 已经把这两种失败变成 demo 会话了）；
    // 留着是因为 `DEMO_MODE=false` 的场合它才是真实结局
    return 'settingsAuthForgotNotReady'
  }
  if (reason === 'rate-limited') {
    return 'settingsAuthResetRateLimited'
  }
  if (reason === 'network') {
    return 'sub2authNetworkError'
  }
  return 'settingsAuthResetFailed'
}

/** 重置失败 → 上屏文案（码错 / 密码太弱在调用点就地落到字段上，这里只兜「条幅级」的几种） */
const resetFailureKey = (reason: ResetWithCodeFailure): TranslationKey => {
  if (reason === 'not-enabled') {
    return 'settingsAuthForgotNotReady'
  }
  if (reason === 'rate-limited') {
    return 'settingsAuthResetRateLimited'
  }
  if (reason === 'network') {
    return 'sub2authNetworkError'
  }
  if (reason === 'weak-password') {
    return 'settingsAuthResetPasswordTooShort'
  }
  if (reason === 'invalid-code') {
    return 'settingsAuthResetCodeWrong'
  }
  return 'settingsAuthResetFailed'
}

export const ResetPasswordPage = ({
  embedded = false,
  initialEmail = '',
  onBack,
  onReset,
}: ResetPasswordPageProps) => {
  const t = useTranslate()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [cooldown, setCooldown] = useState(0)
  /** 这一轮倒计时为什么起（`limited` = 429） */
  const [cooldownReason, setCooldownReason] = useState<CooldownReason>('sent')
  /** 提交被 429 挡回来之后的冷却秒数（>0 = 主按钮禁用 + 显示剩余秒数） */
  const [submitCooldown, setSubmitCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  /**
   * 两把同步闩（`sending` / `submitting` 都是 state，同一 tick 连点两次会都读到旧值 ——
   * 与 `AppUpdateField` 那个坑同源）。state 仍负责置灰与 `aria-busy`，闩负责「一个都不放行」。
   */
  const sendInFlight = useRef(false)
  const submitInFlight = useRef(false)
  /** 演示会话（`null` = 走的是真后端）；`reason` 决定提示里那句补充怎么讲 */
  const [demo, setDemo] = useState<{ reason: DemoReason } | null>(null)
  /** 条幅级失败（限流 / 网络 / 后端没开 / 其它）：一次只能有一条 */
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null)
  /** 字段级失败（本地校验 + 服务端说码错）：就地提示，切字段即清 */
  const [issue, setIssue] = useState<FieldIssue | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // 卸载即结束演示会话：离开这一页之后，「123456 能用」这件事不该还有效
      resetPasswordDemoState()
    }
  }, [])

  // 倒计时：逐秒 setTimeout，卸载即清（与 RegisterPage 同口径，不用 setInterval）
  useEffect(() => {
    if (cooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setCooldown(tickCooldown), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  // 提交链路的 429 冷却：同一套逐秒步进
  useEffect(() => {
    if (submitCooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setSubmitCooldown(tickCooldown), 1000)
    return () => window.clearTimeout(timer)
  }, [submitCooldown])

  const clearIssue = () => {
    if (issue !== null) {
      setIssue(null)
    }
  }

  /** 第一步：发验证码（成功 → 进第二步；失败 → 条幅，留在原地；429 → 冷却倒计时，留在原地） */
  const sendCode = async () => {
    if (sending || cooldown > 0 || sendInFlight.current) {
      return
    }
    if (!isValidEmail(email)) {
      setIssue({
        field: 'email',
        key: email.trim() === '' ? 'settingsAuthResetNeedsEmail' : 'sub2authEmailInvalid',
      })
      return
    }
    setIssue(null)
    setErrorKey(null)
    sendInFlight.current = true
    setSending(true)
    try {
      const result = await requestResetCode(email)
      if (!alive.current) {
        return
      }
      if (!result.ok) {
        if (result.reason === 'rate-limited') {
          // 429 不是失败：按服务端 `Retry-After` 进冷却（没有该头就 60s），按钮禁用 + 显示剩余秒数
          setCooldownReason('limited')
          setCooldown(result.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS)
          return
        }
        setErrorKey(requestFailureKey(result.reason))
        return
      }
      setDemo(result.demo ? { reason: result.demoReason } : null)
      setCooldownReason('sent')
      setCooldown(CODE_COOLDOWN_SECONDS)
      setStep('code')
    } finally {
      sendInFlight.current = false
      if (alive.current) {
        setSending(false)
      }
    }
  }

  /** 第二步：提交（本地先拦三道，再发请求；码错留在第二步并标红） */
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting || submitInFlight.current || submitCooldown > 0) {
      return
    }
    if (!isValidResetCode(code)) {
      setIssue({ field: 'code', key: 'settingsAuthResetCodeWrong' })
      return
    }
    if (password.length < MIN_RESET_PASSWORD_LENGTH) {
      setIssue({ field: 'password', key: 'settingsAuthResetPasswordTooShort' })
      return
    }
    if (password !== confirm) {
      setIssue({ field: 'confirm', key: 'settingsAuthPasswordMismatch' })
      return
    }
    setIssue(null)
    setErrorKey(null)
    submitInFlight.current = true
    setSubmitting(true)
    try {
      const result = await resetPasswordWithCode(email, code, password)
      if (!alive.current) {
        return
      }
      if (!result.ok) {
        if (result.reason === 'rate-limited') {
          // 429：不是「重置失败」，是「太频繁」—— 冷却 + 禁用 + 剩余秒数，倒计时结束自动恢复
          setSubmitCooldown(result.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS)
          return
        }
        // 「码错」与「密码太弱」落到字段上（用户能直接改那一个格子），其余落条幅
        if (result.reason === 'invalid-code' || result.reason === 'weak-password') {
          setIssue({
            field: result.reason === 'invalid-code' ? 'code' : 'password',
            key: resetFailureKey(result.reason),
          })
          return
        }
        setErrorKey(resetFailureKey(result.reason))
        return
      }
      resetPasswordDemoState()
      onReset(email.trim())
    } finally {
      submitInFlight.current = false
      if (alive.current) {
        setSubmitting(false)
      }
    }
  }

  const back = () => {
    resetPasswordDemoState()
    onBack()
  }

  const issueOf = (field: ResetField): TranslationKey | null =>
    issue !== null && issue.field === field ? issue.key : null

  const emailIssue = issueOf('email')
  const codeIssue = issueOf('code')
  const passwordIssue = issueOf('password')
  const confirmIssue = issueOf('confirm')
  const resendDisabled = sending || cooldown > 0
  /** 哪条链路正在 429 冷却里（冷却期间不讲「失败」，只讲「太频繁」） */
  const codeLimited = cooldown > 0 && cooldownReason === 'limited'
  const submitDisabled = submitting || submitCooldown > 0
  const demoHint =
    demo === null
      ? null
      : demo.reason === 'unreachable'
        ? `${t('settingsAuthResetDemoHint')}${t('settingsAuthResetDemoUnreachable')}`
        : t('settingsAuthResetDemoHint')

  return (
    <div className={embedded ? styles.embedded : styles.page} data-testid="reset-password-page">
      <div className={styles.card}>
        <div className={styles.backRow}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={back}
            data-testid="reset-password-back"
          >
            <span aria-hidden="true">‹&nbsp;</span>
            {t('settingsAuthForgotBack')}
          </button>
        </div>

        <h1 className={styles.title}>{t('settingsAuthForgotTitle')}</h1>

        {demoHint !== null ? (
          <p className={styles.demoHint} role="status" data-testid="reset-password-demo-hint">
            {demoHint}
          </p>
        ) : null}

        {errorKey !== null && !codeLimited && submitCooldown <= 0 ? (
          <div className={styles.banner} role="alert" data-testid="reset-password-error">
            <span className={styles.bannerIcon} aria-hidden="true">
              <IconToastError16 />
            </span>
            <span>{t(errorKey)}</span>
          </div>
        ) : null}

        {step === 'email' ? (
          <form
            className={styles.form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void sendCode()
            }}
          >
            <label className={styles.field}>
              <span className={styles.label}>{t('sub2authEmail')}</span>
              <input
                className={emailIssue !== null ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                type="email"
                name="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t('settingsAuthEmailPlaceholder')}
                value={email}
                aria-invalid={emailIssue !== null ? true : undefined}
                data-testid="reset-password-email"
                onChange={(event) => {
                  setEmail(event.target.value)
                  clearIssue()
                  setErrorKey(null)
                }}
              />
              {emailIssue !== null ? (
                <span className={styles.fieldError} role="alert">
                  {t(emailIssue)}
                </span>
              ) : null}
            </label>

            <div className={styles.actions}>
              <Button
                type="submit"
                variant="primary"
                size="l"
                block
                // 第一步被 429 挡回来后同样要禁用（冷却没走完再点一定还是 429）
                disabled={sending || cooldown > 0}
                aria-busy={sending}
                testId="reset-password-send"
              >
                <span className={styles.submit}>
                  {sending ? <span className={styles.spinner} aria-hidden="true" /> : null}
                  {t('sub2authSendCode')}
                </span>
              </Button>
            </div>

            {cooldown > 0 ? (
              <p className={styles.hint} role="status" data-testid="reset-password-rate-limited">
                {codeLimited
                  ? t('sub2authTooManyTries', { seconds: cooldown })
                  : t('sub2authCodeSent', { seconds: cooldown })}
              </p>
            ) : null}
          </form>
        ) : (
          <form className={styles.form} noValidate onSubmit={submit}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reset-password-code">
                {t('settingsAuthCodePlaceholder')}
              </label>
              <div className={styles.codeRow}>
                <input
                  id="reset-password-code"
                  className={codeIssue !== null ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                  type="text"
                  name="code"
                  // 手机上直接起数字键盘；`pattern` 不给（WebView 83 上有兼容坑），靠 onChange 过滤
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  aria-invalid={codeIssue !== null ? true : undefined}
                  data-testid="reset-password-code"
                  onChange={(event) => {
                    // 只留数字，且最多 6 位（粘贴带空格 / 带符号的也能落成合法长度）
                    setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    clearIssue()
                    setErrorKey(null)
                  }}
                />
                <Button
                  variant="outlined"
                  size="l"
                  className={styles.codeButton}
                  disabled={resendDisabled}
                  aria-busy={sending}
                  testId="reset-password-resend"
                  onClick={() => {
                    void sendCode()
                  }}
                >
                  {cooldown > 0 ? t('settingsAuthCountdown', { seconds: cooldown }) : t('sub2authSendCode')}
                </Button>
              </div>
              {codeIssue !== null ? (
                <span className={styles.fieldError} role="alert">
                  {t(codeIssue)}
                </span>
              ) : cooldown > 0 ? (
                <span
                  className={styles.hint}
                  role="status"
                  data-testid={codeLimited ? 'reset-password-rate-limited' : undefined}
                >
                  {codeLimited
                    ? t('sub2authTooManyTries', { seconds: cooldown })
                    : t('sub2authCodeSent', { seconds: cooldown })}
                </span>
              ) : null}
            </div>

            <label className={styles.field}>
              <span className={styles.label}>{t('settingsAuthResetNewPassword')}</span>
              <input
                className={passwordIssue !== null ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                type="password"
                name="newPassword"
                autoComplete="new-password"
                value={password}
                aria-invalid={passwordIssue !== null ? true : undefined}
                data-testid="reset-password-new"
                onChange={(event) => {
                  setPassword(event.target.value)
                  clearIssue()
                  setErrorKey(null)
                }}
              />
              {passwordIssue !== null ? (
                <span className={styles.fieldError} role="alert">
                  {t(passwordIssue)}
                </span>
              ) : null}
            </label>

            <label className={styles.field}>
              <span className={styles.label}>{t('sub2authConfirmPassword')}</span>
              <input
                className={confirmIssue !== null ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                placeholder={t('settingsAuthConfirmPlaceholder')}
                value={confirm}
                aria-invalid={confirmIssue !== null ? true : undefined}
                data-testid="reset-password-confirm"
                onChange={(event) => {
                  setConfirm(event.target.value)
                  clearIssue()
                  setErrorKey(null)
                }}
              />
              {confirmIssue !== null ? (
                <span className={styles.fieldError} role="alert">
                  {t(confirmIssue)}
                </span>
              ) : null}
            </label>

            <div className={styles.actions}>
              <Button
                type="submit"
                variant="primary"
                size="l"
                block
                disabled={submitDisabled}
                aria-busy={submitting}
                testId="reset-password-submit"
              >
                <span className={styles.submit}>
                  {submitting ? <span className={styles.spinner} aria-hidden="true" /> : null}
                  {t('settingsAuthResetSubmit')}
                </span>
              </Button>
            </div>

            {submitCooldown > 0 ? (
              <p className={styles.hint} role="status" data-testid="reset-password-submit-rate-limited">
                {t('sub2authTooManyTries', { seconds: submitCooldown })}
              </p>
            ) : null}

            {demoHint !== null ? (
              // 演示会话里把「码是什么」再说一次：`secret`-style 提示不放，这里本来就是公开常量
              <p className={styles.hint} data-testid="reset-password-demo-code">
                {t('settingsAuthResetDemoCode', { code: DEMO_CODE })}
              </p>
            ) : null}
          </form>
        )}
      </div>
    </div>
  )
}
