import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export function loadFixtureHtml(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

export function parseFixture(name: string): Document {
  return new DOMParser().parseFromString(loadFixtureHtml(name), 'text/html')
}
