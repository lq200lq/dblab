import { describe, expect, it } from 'vitest'

import { CliError } from '../src/core/errors'
import { apiKeyPrefixOf, assertApiKeyShape, isValidApiKeyShape, maskKey } from '../src/core/key'

const VALID = `dblab_ab12cd34_${'A'.repeat(43)}`

describe('密钥形态', () => {
  it('接受合规明文', () => {
    expect(isValidApiKeyShape(VALID)).toBe(true)
    expect(assertApiKeyShape(` ${VALID} `)).toBe(VALID)
  })

  it('拒绝定位段长度不对、秘密段长度不对、前缀不对的输入', () => {
    expect(isValidApiKeyShape('dblab_ab12cd3_AAA')).toBe(false)
    expect(isValidApiKeyShape(`dblab_ab12cd34_${'A'.repeat(42)}`)).toBe(false)
    expect(isValidApiKeyShape(`sk_ab12cd34_${'A'.repeat(43)}`)).toBe(false)
    expect(isValidApiKeyShape('')).toBe(false)
  })

  it('形态不对时抛 usage 错误', () => {
    expect(() => assertApiKeyShape('nope')).toThrow(CliError)
  })
})

describe('maskKey', () => {
  it('保留定位段、遮掉秘密段', () => {
    const masked = maskKey(VALID)
    expect(masked).toBe('dblab_ab12cd34_••••')
    expect(masked).not.toContain('AAAA')
  })

  it('对畸形输入也不泄露内容', () => {
    expect(maskKey('whatever-secret')).toBe('dblab_••••')
  })

  it('秘密段里含下划线时仍能取到定位段（base64url 允许 _）', () => {
    const withUnderscore = 'dblab_ab12cd34_AAAAA_aaa_BBBB_cccc_DDDD'
    expect(maskKey(withUnderscore)).toBe('dblab_ab12cd34_••••')
    expect(maskKey(withUnderscore)).not.toContain('BBBB')
  })
})

describe('apiKeyPrefixOf', () => {
  it('取 dblab_<定位段>，与库里 prefix 列同形', () => {
    expect(apiKeyPrefixOf(VALID)).toBe('dblab_ab12cd34')
  })

  it('秘密段含下划线时不会被切错', () => {
    expect(apiKeyPrefixOf('dblab_ab12cd34_AAAA_bbbb_CCCC')).toBe('dblab_ab12cd34')
  })

  it('畸形输入返回空串（交给上层判定）', () => {
    expect(apiKeyPrefixOf('nope')).toBe('')
  })
})
