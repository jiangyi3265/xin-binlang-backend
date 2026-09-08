import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const encoder = new TextEncoder()

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw Object.assign(new Error('密码至少需要 8 位'), { statusCode: 400, code: 'ERR_PASSWORD_WEAK' })
  }
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded).split('$')
    if (algorithm !== 'scrypt') return false
    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(hashText, 'base64url')
    const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function signToken(payload, secret, ttlSeconds = 8 * 60 * 60) {
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const now = Math.floor(Date.now() / 1000)
  const body = encode({ ...payload, iat: now, exp: now + ttlSeconds, jti: randomBytes(12).toString('hex') })
  const input = `${header}.${body}`
  const signature = createHmac('sha256', secret).update(input).digest('base64url')
  return `${input}.${signature}`
}

export function verifyToken(token, secret) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const input = `${parts[0]}.${parts[1]}`
  const expected = createHmac('sha256', secret).update(input).digest()
  let actual
  try {
    actual = Buffer.from(parts[2], 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = decode(parts[1])
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function bearerToken(headers) {
  const value = headers.authorization || headers.Authorization || ''
  const match = /^Bearer\s+(.+)$/i.exec(value)
  return match ? match[1] : ''
}

export function safeUser(user) {
  if (!user) return null
  const { password_hash, ...rest } = user
  return rest
}

export function randomCode(length = 6) {
  const alphabet = '0123456789'
  const bytes = randomBytes(length * 2)
  let out = ''
  for (const byte of bytes) {
    // Discard the incomplete range so every digit remains equally likely.
    if (byte >= 250) continue
    out += alphabet[byte % alphabet.length]
    if (out.length === length) return out
  }
  return randomCode(length)
}

export function randomId(prefix = '') {
  return prefix + randomBytes(10).toString('hex').toUpperCase()
}

export function constantTimeTextEqual(a, b) {
  const left = encoder.encode(String(a))
  const right = encoder.encode(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}
