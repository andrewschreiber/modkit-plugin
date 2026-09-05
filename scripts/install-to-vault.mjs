#!/usr/bin/env node
// Install the built modkit plugin into an Obsidian vault.
//
// Deliberately dumb: it copies three files into .obsidian/plugins/modkit/ and stops.
// It does NOT touch community-plugins.json — enabling modkit is the user's click, and
// writing that file behind Obsidian's back while it is running loses the write anyway
// (Obsidian holds its own copy in memory and rewrites on change).
//
//   node scripts/install-to-vault.mjs [--vault <path>] [--id modkit]
//
// Default vault comes from $OBSIDIAN_VAULT, else ~/Documents/Obsidian Vault.
//
// It is also a *module*: `scripts/setup.mjs` imports {@link installToVault} rather than
// reimplementing the copy, so there is exactly one definition of "installed" and the two entry
// points cannot drift. The function throws {@link InstallError}; only the CLI below decides that
// an error means printing two lines and exiting 1.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { access, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The files a plugin folder needs. `styles.css` is optional; the other two are not. */
const PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css']

/** An error a caller can act on: `hint` is the sentence that tells a human what to do next. */
export class InstallError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'InstallError'
    this.hint = hint
  }
}

export function defaultVault() {
  return resolve(process.env.OBSIDIAN_VAULT || join(homedir(), 'Documents', 'Obsidian Vault'))
}

export async function exists(p) {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Copy `plugin/dist` into `<vault>/.obsidian/plugins/<id>/`.
 *
 * Returns what it did rather than printing it, so `setup.mjs` can fold this into its own one-line-
 * per-step report. `enabled` is read from `community-plugins.json` — it is the difference between
 * "enable it" and "reload it" as the next instruction, and getting that wrong is the fastest way
 * to make someone think the build did not land.
 */
export async function installToVault({ vault = defaultVault(), id = 'modkit', src = join(REPO, 'plugin', 'dist') } = {}) {
  const vaultPath = resolve(vault)
  const dest = join(vaultPath, '.obsidian', 'plugins', id)

  // A vault is a directory with a .obsidian in it. Checking is worth it: a typo'd --vault
  // would otherwise silently create a plausible-looking plugin tree in the wrong place.
  if (!(await exists(join(vaultPath, '.obsidian')))) {
    throw new InstallError(
      `Not an Obsidian vault (no .obsidian directory): ${vaultPath}`,
      'Pass --vault <path> or set $OBSIDIAN_VAULT.',
    )
  }

  if (!(await exists(join(src, 'main.js')))) {
    throw new InstallError(`No build found at ${src}/main.js`, 'Run: npm run build:plugin')
  }

  await mkdir(dest, { recursive: true })

  const copied = []
  for (const f of PLUGIN_FILES) {
    const from = join(src, f)
    if (!(await exists(from))) {
      if (f === 'styles.css') continue // optional
      throw new InstallError(`Missing ${from}`, 'Run: npm run build:plugin')
    }
    await copyFile(from, join(dest, f))
    const { size } = await stat(join(dest, f))
    copied.push({ file: f, bytes: size })
  }

  const manifest = JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8'))

  // Report whether the vault already has it enabled, so the next instruction is the right one.
  let enabled = false
  try {
    const list = JSON.parse(await readFile(join(vaultPath, '.obsidian', 'community-plugins.json'), 'utf8'))
    enabled = Array.isArray(list) && list.includes(id)
  } catch {
    /* absent until the first community plugin is enabled */
  }

  return { vault: vaultPath, id, dest, copied, manifest, enabled }
}

/* ────────────────────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────────────────────── */

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const IS_MAIN = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

if (IS_MAIN) {
  try {
    const result = await installToVault({
      vault: arg('vault', defaultVault()),
      id: arg('id', 'modkit'),
    })
    console.log(`✓ ${result.manifest.name} ${result.manifest.version} → ${result.dest}`)
    for (const c of result.copied) console.log(`  ${c.file} (${c.bytes.toLocaleString()} B)`)
    console.log()
    if (result.enabled) {
      console.log('  Already enabled. In Obsidian: Settings → Community plugins → toggle modkit')
      console.log('  off and on to load this build.')
    } else {
      console.log('  Next: Obsidian → Settings → Community plugins → enable "modkit".')
      console.log('  (If Obsidian is already open, it may need a moment to notice the new folder;')
      console.log('   the refresh button next to "Installed plugins" forces a rescan.)')
    }
  } catch (err) {
    if (err instanceof InstallError) {
      console.error(`✗ ${err.message}`)
      if (err.hint) console.error(`  ${err.hint}`)
      process.exit(1)
    }
    throw err
  }
}
