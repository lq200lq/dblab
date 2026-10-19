/**
 * 交互输入。抽一层是为了让命令层能在测试里注入假实现——
 * 向导逻辑（步骤顺序、默认值、校验）才是要测的东西，不该被 TTY 拦住。
 */
export interface Choice<T> {
  name: string
  value: T
  checked?: boolean
  disabled?: boolean | string
}

export interface Prompts {
  input(options: {
    message: string
    default?: string
    validate?: (value: string) => true | string
  }): Promise<string>

  password(options: {
    message: string
    mask?: string
    validate?: (value: string) => true | string
  }): Promise<string>

  checkbox<T>(options: {
    message: string
    choices: readonly Choice<T>[]
  }): Promise<T[]>

  confirm(options: { message: string; default?: boolean }): Promise<boolean>
}

/** 默认实现：真终端下用 @inquirer/prompts（掩码输入与多选在 Windows 上最稳）。 */
export async function createPrompts(): Promise<Prompts> {
  const inquirer = await import('@inquirer/prompts')
  return {
    input: (options) =>
      inquirer.input({
        message: options.message,
        ...(options.default !== undefined ? { default: options.default } : {}),
        ...(options.validate ? { validate: options.validate } : {}),
      }),
    password: (options) =>
      inquirer.password({
        message: options.message,
        mask: options.mask ?? '*',
        ...(options.validate ? { validate: options.validate } : {}),
      }),
    checkbox: (options) =>
      inquirer.checkbox({
        message: options.message,
        choices: options.choices.map((choice) => ({ ...choice })),
      }),
    confirm: (options) => inquirer.confirm({ message: options.message, default: options.default }),
  }
}
