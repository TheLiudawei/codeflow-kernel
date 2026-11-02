/**
 * 跨平台路径解析——内核里唯一碰「用户怎么写了一个路径」的地方。
 *
 * 三个输入形状在这里收敛：`@/abs/path`（编辑器提及标记）、`"~/My Project"`
 * （引号 + 波浪号）、`file:///Users/me/x`（URL）。之后再没有人需要关心旋钮
 * 在哪个平台、带不带引号、是不是相对路径。
 *
 * 与宿主无关：只依赖 `node:*`，可以在 CLI、MCP server、CI 里同样运行。
 *
 * @module codeflow-kernel/engine/paths
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Strip one or two matching outer quotes (editors may wrap a pasted path). */
function unquote(value) {
  let text = value
  for (let pass = 0; pass < 2; pass += 1) {
    if (text.length < 2) break
    const first = text[0]
    if ((first !== '"' && first !== "'" && first !== '`') || text[text.length - 1] !== first) break
    text = text.slice(1, -1).trim()
  }
  return text
}

/**
 * 把任意用户输入变成一个文件系统路径。
 *
 * 接受剪贴板/输入框里常见的各种形状：`@/abs/path`、`"~/My Project"`、
 * `file:///Users/me/x`、`./server`。相对路径在给了 `options.cwd` 时相对它
 * 解析；否则原样返回，交给调用方解析。
 *
 * @param input - 来自命令行、对话框或提及的原始文本。
 * @param options.cwd - 相对路径使用的工作目录。
 * @param options.home - 主目录覆盖（测试用）。
 * @returns 归一后的路径；输入为空时 `''`。
 */
export function cleanPathInput(input, options = {}) {
  let value = String(input ?? '').trim()
  if (value.length === 0) return ''

  // 编辑器给选中的路径加 `@` 前缀；粘贴后有时会留下成对的标记。它们是语法，
  // 绝不是路径的一部分。引号可能包住标记（`"@/x"`）也可能包住路径
  // （`@"/x"`），所以两种都要反复剥。
  for (let pass = 0; pass < 4; pass += 1) {
    const before = value
    value = unquote(value).trim()
    while (value.startsWith('@')) value = value.slice(1).trim()
    if (value === before) break
  }

  if (/^file:\/\//i.test(value)) {
    try {
      value = fileURLToPath(value)
    } catch {
      // 畸形的 file URL 原样保留——错误信息才能如实指向用户输入的东西。
    }
  }

  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : homedir()
  if (value === '~') value = home
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(home, value.slice(2))
  if (value.length === 0) return ''

  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined
  if (!path.isAbsolute(value) && cwd !== undefined) value = path.resolve(cwd, value)
  return path.normalize(value)
}

/**
 * 路径当前是否存在且是目录。绝不抛错。
 * @param target - 绝对或相对路径。
 */
export async function isDirectory(target) {
  if (typeof target !== 'string' || target.length === 0) return false
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** `realpath` when possible, otherwise the input unchanged. */
async function realpathOr(target) {
  try {
    return await realpath(target)
  } catch {
    return target
  }
}

/**
 * 解析一个只差 Unicode 规范化形式或大小写的路径。
 *
 * macOS 通常大小写不敏感并对名字做规范化；但在一台机器上敲出、或从另一台
 * 工具复制出来的路径仍可能对不上。这里逐级走目录树：先精确匹配，其次
 * NFC 等价，再次大小写不敏感。
 *
 * @returns 规范目录；任何一级都对不上时 `undefined`。
 */
async function resolveCaseInsensitive(target) {
  const root = path.parse(target).root
  if (root.length === 0) return undefined
  const segments = target.slice(root.length).split(path.sep).filter((segment) => segment.length > 0)
  let current = root
  for (const segment of segments) {
    let entries
    try {
      entries = await readdir(current)
    } catch {
      return undefined
    }
    const wanted = segment.normalize('NFC')
    const match = entries.find((entry) => entry === segment)
      ?? entries.find((entry) => entry.normalize('NFC') === wanted)
      ?? entries.find((entry) => entry.toLowerCase() === segment.toLowerCase())
    if (match === undefined) return undefined
    current = path.join(current, match)
  }
  return (await isDirectory(current)) ? await realpathOr(current) : undefined
}

/**
 * 为用户输入的路径找一个真实存在的目录。
 *
 * 依次尝试：原样拼写、NFC/NFD 变体、（macOS 上）大小写不敏感的逐级匹配。
 *
 * @param target - 待解析路径。
 * @returns 规范目录，或 `undefined`。
 */
export async function findDirectory(target) {
  if (typeof target !== 'string' || target.length === 0) return undefined
  const candidates = []
  const remember = (value) => {
    if (typeof value === 'string' && value.length > 0 && !candidates.includes(value)) candidates.push(value)
  }
  remember(target)
  try {
    remember(target.normalize('NFC'))
    remember(target.normalize('NFD'))
  } catch {
    // 孤立代理对无法规范化；字面候选仍然可用。
  }
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return await realpathOr(candidate)
  }
  if (process.platform === 'darwin') return await resolveCaseInsensitive(target)
  return undefined
}

/**
 * 解析项目根，并且不隐藏失败原因。
 *
 * @param input - 用户路径（可能是 `@` 提及或 `~` 路径）。
 * @param cwd - 相对路径使用的工作目录。
 * @returns 规范的绝对目录。
 * @throws 路径缺失、是文件或不可读时。
 */
export async function resolveProjectRoot(input, cwd) {
  const cleaned = cleanPathInput(input, { cwd })
  if (cleaned.length === 0) throw new Error('未提供项目路径')
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd ?? process.cwd(), cleaned)
  // 原拼写能用就保留它：macOS 的 `realpath` 会把 `/var/...` 改写成
  // `/private/var/...`，而符号链接过的项目应当继续能以用户选的名字被访问。
  if (await isDirectory(absolute)) return absolute
  const found = await findDirectory(absolute)
  if (found !== undefined) return found
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error(`目录不存在：${absolute}`)
    throw new Error(`无法访问：${absolute}（${error?.code ?? error?.message ?? error}）`)
  }
  if (!info.isDirectory()) throw new Error(`不是目录：${absolute}`)
  return absolute
}
