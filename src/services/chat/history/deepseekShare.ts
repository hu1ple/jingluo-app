import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { fail } from './errors.js'
import { readSessionFile } from './schema.js'
import { toLocalSessionResult } from './toLocal.js'

const origin = 'https://chat.deepseek.com'

export function shareIdOf(input: string): string {
  const raw = input.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return fail('shareInvalid')
  }
  if (url.hostname !== 'chat.deepseek.com' || url.username || url.password)
    {
      return fail('shareUnofficial')
    }
  if (url.origin !== origin || !url.pathname.startsWith('/share/') || /[\\\s]/.test(raw))
    {
      return fail('shareInvalid')
    }
  // URL normalizes dot segments and missing slashes; validate the original share path too.
  const match =
    /^https:\/\/chat\.deepseek\.com(?::443)?\/share\/([A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/i.exec(
      raw
    )
  return match?.[1] ?? fail('shareInvalid')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('shareUnreadable')
  }
  return value as Record<string, unknown>
}

export function sessionFromShare(id: string, body: unknown) {
  const envelope = object(body)
  if (envelope.code !== 0) {
    return fail('shareFetchFailed')
  }
  const result = object(envelope.data)
  if (result.biz_code !== 0) {
    return fail(result.biz_msg === 'share does not exist' ? 'shareUnavailable' : 'shareFetchFailed')
  }
  const data = object(result.biz_data)
  if (!Array.isArray(data.messages) || !data.messages.length) {
    return fail('shareUnreadable')
  }
  try {
    const messages = data.messages.map((value: unknown) => {
      const m = object(value)
      if (typeof m.inserted_at !== 'number' || !Array.isArray(m.fragments))
        {
          return fail('shareUnreadable')
        }
      return {
        ...m,
        id: m.message_id,
        inserted_at: new Date(m.inserted_at * 1000).toISOString(),
        fragments: m.fragments.map((value: unknown) => {
          const f = object(value)
          return f.type === 'THINK' ? { ...f, elapsed_secs: f.elapsed_secs ?? null } : f
        }),
      }
    })
    const file = readSessionFile({
      id: 'deepseek-share-' + id,
      title: data.title ?? null,
      messages,
      current_message_id: messages[messages.length - 1].id,
      inserted_at: messages[0].inserted_at,
      updated_at: new Date().toISOString(),
    })
    // Unsupported fragments must not silently turn a conversation into empty messages.
    if (file.messages.some((m, i) => m.fragments.length !== messages[i].fragments.length))
      {
        return fail('shareUnreadable')
      }
    const local = toLocalSessionResult(file)
    if (!local.ok || local.skipped.length) {
      return fail('shareUnreadable')
    }
    return local.session.session
  } catch {
    return fail('shareUnreadable')
  }
}

export async function readDeepSeekShare(input: string) {
  const id = shareIdOf(input)
  let status: number
  let body: unknown
  try {
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({
        url: origin + '/api/v0/share/content?share_id=' + id,
        headers: { Accept: 'application/json' },
        responseType: 'json',
        connectTimeout: 10000,
        readTimeout: 20000,
        disableRedirects: true,
      })
      status = response.status
      body = response.data
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 25000)
      try {
        const response = await fetch('/api/deepseek-share/' + id, {
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        })
        status = response.status
        if (response.ok) {body = await response.json()}
      } finally {
        clearTimeout(timer)
      }
    }
  } catch {
    return fail('shareFetchFailed')
  }
  if (status === 410 || (Capacitor.isNativePlatform() && status === 404))
    {
      return fail('shareUnavailable')
    }
  if (status !== 200) {
    return fail('shareFetchFailed')
  }
  return sessionFromShare(id, body)
}
