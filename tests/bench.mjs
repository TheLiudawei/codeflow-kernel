/**
 * 基准：固定 fixture（60 个模块）跑真实分析，打印耗时与结论。
 *
 * 数字不是营销——它同时是回归守卫：两次运行的耦合分数必须一致，否则
 * 脚本以非零退出，说明某个分析器引入了随机性。
 *
 * @module codeflow-kernel/tests/bench
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { analyzeRepository } from '../lib/index.js'

/** 纯函数生成 60 个互相 import 的模块——任何机器上内容一致。 */
async function makeBenchFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'codeflow-kernel-bench-'))
  const count = 60
  for (let i = 0; i < count; i += 1) {
    const rel = `src/mod${String(i).padStart(2, '0')}.js`
    const deps = i + 1 < count ? [`import { fn${i + 1} } from './mod${String(i + 1).padStart(2, '0')}.js'`] : []
    const content = [
      ...deps,
      `import { readFile } from 'node:fs/promises'`,
      '',
      `export function fn${i}() {`,
      '  return readFile',
      '}',
      '',
      i % 10 === 0 ? `// TODO: refactor module ${i}` : '',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
    const file = path.join(root, ...rel.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'bench-fixture', version: '1.0.0' }), 'utf8')
  return root
}

/** 跑一次并计时。 */
async function measure(root, runs) {
  const samples = []
  let last
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now()
    last = await analyzeRepository({ path: root, maxFiles: 1000 })
    samples.push(performance.now() - startedAt)
  }
  samples.sort((left, right) => left - right)
  return { last, median: samples[Math.floor(samples.length / 2)], samples }
}

const root = await makeBenchFixture()
try {
  // 冷启动一次（模块加载 + 文件系统缓存预热），随后取 3 次中位数。
  await analyzeRepository({ path: root, maxFiles: 1000 })
  const { last, median, samples } = await measure(root, 3)

  const second = await analyzeRepository({ path: root, maxFiles: 1000 })
  const deterministic = JSON.stringify(second.coupling.files) === JSON.stringify(last.coupling.files)

  const rows = [
    ['fixture', `${last.coupling.counts.modules} 个源码文件`],
    ['图内模块', `${last.stats.modules}（节点上限 36）`],
    ['任务节点', String(last.stats.tasks)],
    ['耦合分数', `${last.coupling.overall.score}/100（${last.coupling.overall.level}）`],
    ['环文件', String(last.coupling.overall.cycles)],
    ['功能数', String(last.stats.features)],
    ['耗时（中位数）', `${Math.round(median)}ms`],
    ['耗时（三次）', samples.map((value) => `${Math.round(value)}ms`).join(' / ')],
    ['确定性', deterministic ? '两次结果逐字节一致' : '不一致（失败）'],
  ]
  const width = Math.max(...rows.map(([label]) => label.length))
  for (const [label, value] of rows) {
    if (value === '') continue
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`)
  }
  if (!deterministic) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
