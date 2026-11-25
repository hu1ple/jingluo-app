/**
 * N6 设置重载 + 来源凭证隔离（域 9）的**唯一数据源**。
 *
 * N2 已经证明「模块层读回」：写进去、重启后 `useSettings` / `getProviderKind()` 读得到。
 * 但那只证明**模块读到了键**，证不到**界面真的消费了它**（主题没落到 `body.dark`、
 * 阅读档没落到根 `data-*`、生效来源没落到手风琴里打勾的那一行）。这一层需要真实产物 + reload。
 *
 * 一行 = 一张 seed 表 + 一次 reload + 一组界面断言：
 *   `seed` → reload → `probe` 决定了要看界面的哪一处，`expect` 是期望值。
 *
 * ## F9-09 / F9-10 的口径（裁决 2026-11-26，见 docs/testing/product-debt.md）
 *
 * 意图是「**重载后凭证不串**」，不是「渠道下拉回到某个值」（#807 之后来源页是三行手风琴，
 * 没有下拉）。所以：
 *  - `currentRow`：重载后打勾的那一行 = seed 的 `chat-demo:provider-kind` 对应的那一行
 *    （`rowOfKind`：ours→builtin / deepseek→official / 其余→third）；
 *  - `third` / `official`：两行各自的**草稿**里只有自己那一份地址/模型 —— 互不合并、互不丢失。
 *    「A 的地址被带进 B」是 #339 的根因，也是这里唯一要钉的东西。
 */

export const FAKE_KEY = 'sk-reload-matrix-0123456789'

const ANTHROPIC_BASE = 'https://relay-a.example.com'
const ANTHROPIC_MODEL = 'claude-relay-model'
const OPENAI_BASE = 'https://relay-o.example.com'
const OPENAI_MODEL = 'gpt-relay-model'

/**
 * 这两条地址的 host 会被界面拿去探测（展开「第三方服务」时 `detectThirdPartyProtocol()`）。
 * 用例必须按 **host + path** 打桩，否则探针会一路发到外网（#673 实测：改前每条真出网）。
 * 在 fixture 里导出 host，避免用例自己再抄一遍字符串。
 */
export const ANTHROPIC_HOST = new URL(ANTHROPIC_BASE).host
export const OPENAI_HOST = new URL(OPENAI_BASE).host

/** 两个自填槽位各自一份配置：切来切去都不许互串（#339 的根因在读取侧） */
const SCOPED_SEED = {
  'chat-demo:provider-kind': 'anthropic',
  'chat-demo:api-key': FAKE_KEY,
  'chat-demo:base-url:anthropic': ANTHROPIC_BASE,
  'chat-demo:model:anthropic': ANTHROPIC_MODEL,
  'chat-demo:base-url:openai': OPENAI_BASE,
  'chat-demo:model:openai': OPENAI_MODEL,
  'chat-demo:base-url': 'https://shared-legacy.example.com',
  'chat-demo:model': 'shared-legacy-model',
}

/** 第三方 / 官方两行的草稿期望（官方是「地址固定、只填 Key」，没有可编辑的地址与模型） */
const THIRD_ANTHROPIC = {
  currentRow: 'third',
  third: { baseUrl: ANTHROPIC_BASE, model: ANTHROPIC_MODEL },
  thirdForbids: [OPENAI_BASE, OPENAI_MODEL, 'shared-legacy-model'],
  official: { editableBaseUrl: false, editableModel: false },
}
const THIRD_OPENAI = {
  currentRow: 'third',
  third: { baseUrl: OPENAI_BASE, model: OPENAI_MODEL },
  thirdForbids: [ANTHROPIC_BASE, ANTHROPIC_MODEL, 'shared-legacy-model'],
  official: { editableBaseUrl: false, editableModel: false },
}

export const RELOAD_CASES = [
  {
    id: 'R1',
    fn: 'F9-01',
    label: '主题=深色：重载后界面真的是深色',
    seed: { 'chat-demo:theme-preference': 'dark' },
    probe: 'theme',
    expect: { dark: true, light: false },
  },
  {
    id: 'R2',
    fn: 'F9-01',
    label: '主题=浅色：重载后界面真的是浅色',
    seed: { 'chat-demo:theme-preference': 'light' },
    probe: 'theme',
    expect: { dark: false, light: true },
  },
  {
    id: 'R3',
    fn: 'F9-01',
    label: '主题=跟随系统 + 系统深色 → 界面深色',
    seed: { 'chat-demo:theme-preference': 'system' },
    context: { colorScheme: 'dark' },
    probe: 'theme',
    expect: { dark: true, light: false },
  },
  {
    id: 'R4',
    fn: 'F9-02',
    label: '阅读三档（大 / 加粗 / 宽松）落到根元素 data-*',
    seed: {
      'chat-demo:reading-font-size': 'xlarge',
      'chat-demo:reading-font-weight': 'bold',
      'chat-demo:reading-line-height': 'relaxed',
    },
    probe: 'reading',
    expect: { size: 'xlarge', weight: 'bold', line: 'relaxed' },
  },
  {
    id: 'R5',
    fn: 'F9-03',
    label: '思考显示=展开：设置页的选择器显示「展开」',
    seed: { 'chat-demo:thinking-display': 'expanded' },
    probe: 'select',
    expect: { ariaLabel: '思考过程', label: '展开' },
  },
  {
    id: 'R6',
    fn: 'F9-05',
    label: '回车=只换行：输入框 enterKeyHint 变 enter，选择器同步',
    seed: { 'chat-demo:enter-key-mode': 'button-only' },
    probe: 'enter-key',
    expect: { enterKeyHint: 'enter', ariaLabel: '回车键行为', label: '只换行（点发送按钮才发送）' },
  },
  {
    id: 'R7',
    fn: 'F9-05',
    label: '回车=回车发送：输入框 enterKeyHint = send',
    seed: { 'chat-demo:enter-key-mode': 'enter-send' },
    probe: 'enter-key',
    expect: { enterKeyHint: 'send', ariaLabel: '回车键行为', label: '回车发送（Shift + 回车换行）' },
  },
  {
    id: 'R8',
    fn: 'F9-09',
    label: '来源=第三方（anthropic）：重载后打勾的仍是第三方那一行',
    seed: { 'chat-demo:provider-kind': 'anthropic', 'chat-demo:api-key': FAKE_KEY },
    probe: 'source',
    // F9-09 只问「生效来源还是不是同一行」：不展开别的行，免得为了看空草稿去打一次探针
    expect: { currentRow: 'third' },
  },
  {
    id: 'R9',
    fn: 'F9-09',
    label: '来源=DeepSeek 官方：重载后打勾的仍是官方那一行',
    seed: { 'chat-demo:provider-kind': 'deepseek', 'chat-demo:api-key': FAKE_KEY },
    probe: 'source',
    expect: { currentRow: 'official' },
  },
  {
    id: 'R10',
    fn: 'F9-10',
    label: '来源=第三方（anthropic）：重载后第三方行只读自己那份（不串 OpenAI，也不串共享老键）',
    seed: SCOPED_SEED,
    probe: 'source',
    expect: THIRD_ANTHROPIC,
  },
  {
    id: 'R11',
    fn: 'F9-10',
    label: '来源=第三方（openai）：重载后第三方行只读自己那份（不串 Anthropic）',
    seed: { ...SCOPED_SEED, 'chat-demo:provider-kind': 'openai' },
    probe: 'source',
    expect: THIRD_OPENAI,
  },
  {
    id: 'R12',
    fn: 'F9-10',
    label: '生效来源切到内置服务后，第三方那一份仍然在（别的行的凭证不丢、也不被合并）',
    // 内置服务要「服务端下发的那把」才算已配置（#596）：Key + 下发标记一起种
    seed: async () => {
      const { claimedOursStorage } = await import('../../helpers/ours-claim.mjs')
      return { ...SCOPED_SEED, 'chat-demo:provider-kind': 'ours', ...(await claimedOursStorage(FAKE_KEY)) }
    },
    probe: 'source',
    expect: { ...THIRD_ANTHROPIC, currentRow: 'builtin' },
  },
  {
    id: 'R13',
    fn: 'F9-06',
    label: '语言=en-US：重载后设置弹窗标题是英文',
    seed: { 'chat-demo:locale': 'en-US' },
    probe: 'locale',
    expect: { settingsTitle: 'Settings' },
  },
]
