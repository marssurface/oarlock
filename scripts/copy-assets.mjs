import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'src', 'web', 'public')
const to = join(root, 'dist', 'web', 'public')

mkdirSync(to, { recursive: true })
cpSync(from, to, { recursive: true })
console.log(`copied ${from} -> ${to}`)
