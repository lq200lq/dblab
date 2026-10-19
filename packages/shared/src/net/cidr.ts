/**
 * IP / CIDR 解析与匹配。密钥的 IP 白名单用它，
 * 前端也用 `isValidCidrInput` 做输入预校验，所以放在 shared 里两边同源。
 *
 * 约定：白名单为空 = 不限制来源（由调用方决定语义）；无法解析的条目按「不匹配」处理（fail-closed）。
 */

export type IpVersion = 4 | 6

export interface ParsedIp {
  version: IpVersion
  bytes: Uint8Array
}

export interface ParsedCidr {
  version: IpVersion
  bytes: Uint8Array
  prefix: number
}

function stripDecorations(input: string): string {
  let s = input.trim()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  return s
}

function parseIpv4(input: string): Uint8Array | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i] as string
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes[i] = value
  }
  return bytes
}

function wordsToBytes(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 2)
  words.forEach((word, index) => {
    bytes[index * 2] = (word >> 8) & 0xff
    bytes[index * 2 + 1] = word & 0xff
  })
  return bytes
}

function partsToWords(parts: string[]): number[] | null {
  const words: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    if (part === '') return null
    if (part.includes('.')) {
      // 只允许出现在末尾：::ffff:1.2.3.4
      if (i !== parts.length - 1) return null
      const v4 = parseIpv4(part)
      if (!v4) return null
      words.push(((v4[0] as number) << 8) | (v4[1] as number))
      words.push(((v4[2] as number) << 8) | (v4[3] as number))
      continue
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null
    words.push(Number.parseInt(part, 16))
  }
  return words
}

function parseIpv6(input: string): Uint8Array | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(input)) return null

  const doubleColon = input.indexOf('::')
  if (doubleColon !== -1 && input.indexOf('::', doubleColon + 1) !== -1) return null

  const headText = doubleColon === -1 ? input : input.slice(0, doubleColon)
  const tailText = doubleColon === -1 ? '' : input.slice(doubleColon + 2)

  const head = partsToWords(headText === '' ? [] : headText.split(':'))
  const tail = partsToWords(tailText === '' ? [] : tailText.split(':'))
  if (!head || !tail) return null

  if (doubleColon === -1) {
    if (head.length !== 8) return null
    return wordsToBytes(head)
  }

  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return wordsToBytes([...head, ...new Array<number>(fill).fill(0), ...tail])
}

export function parseIp(input: string): ParsedIp | null {
  const s = stripDecorations(input)
  if (s === '') return null
  const v4 = parseIpv4(s)
  if (v4) return { version: 4, bytes: v4 }
  const v6 = parseIpv6(s)
  if (v6) return { version: 6, bytes: v6 }
  return null
}

export function parseCidr(input: string): ParsedCidr | null {
  const s = stripDecorations(input)
  if (s === '') return null

  const slash = s.indexOf('/')
  const addressText = slash === -1 ? s : s.slice(0, slash)
  const prefixText = slash === -1 ? null : s.slice(slash + 1)

  const ip = parseIp(addressText)
  if (!ip) return null

  const maxPrefix = ip.version === 4 ? 32 : 128
  let prefix = maxPrefix
  if (prefixText !== null) {
    if (!/^\d{1,3}$/.test(prefixText)) return null
    prefix = Number(prefixText)
    if (prefix > maxPrefix) return null
  }

  return { version: ip.version, bytes: ip.bytes, prefix }
}

function matchesPrefix(ip: ParsedIp, net: ParsedCidr): boolean {
  if (ip.version !== net.version) return false
  const fullBytes = Math.floor(net.prefix / 8)
  const remBits = net.prefix % 8
  for (let i = 0; i < fullBytes; i++) {
    if (ip.bytes[i] !== net.bytes[i]) return false
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff
    if (((ip.bytes[fullBytes] as number) & mask) !== ((net.bytes[fullBytes] as number) & mask)) {
      return false
    }
  }
  return true
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const parsedIp = parseIp(ip)
  const parsedCidr = parseCidr(cidr)
  if (!parsedIp || !parsedCidr) return false
  return matchesPrefix(parsedIp, parsedCidr)
}

/** 白名单为空表示不限制来源。 */
export function isIpAllowed(ip: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  const parsedIp = parseIp(ip)
  if (!parsedIp) return false
  for (const entry of allowlist) {
    const parsed = parseCidr(entry)
    if (!parsed) continue
    if (matchesPrefix(parsedIp, parsed)) return true
  }
  return false
}

/** 给前端做输入预校验用：非法条目不允许提交。 */
export function isValidCidrInput(input: string): boolean {
  return parseCidr(input) !== null
}
