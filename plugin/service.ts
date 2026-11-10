import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { PolicyStore, Redactor, RunDir, Serial, Vault, type PermissionBridge } from "oc-secure-kit"
import { SP_SECRET, SSH_KEY, TOKEN_CACHE, type Account, type Discovery, type VmSummary } from "./model.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-azure"
const run = promisify(execFile)
/** Tokens the CLI itself prints (az account get-access-token, --debug). */
export const TOKEN_PATTERNS = [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /\b1\.A[A-Za-z0-9_-]{100,}/]
/** Non-secret CLI state kept per account between commands (subscriptions, defaults, command index). */
const KEEP = ["azureProfile.json", "config", "clouds.config", "commandIndex.json", "versionCheck.json", "msal_http_cache.bin", "extensionIndex.json", "helpIndex.json"]
const CACHE_FILE = "msal_token_cache.json"
const TOOLS_DIR = fileURLToPath(new URL("../tools/", import.meta.url))

export interface SignInState {
  readonly account: string
  status: "waiting" | "done" | "failed"
  /** Browser sign-in: where az sent the browser. Device: where to enter the code. */
  url?: string
  code?: string
  error?: string
  readonly expiresAt: number
  cancel(): void
}

export interface AzResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }

/** Finds pixi for installing the Azure CLI. */
async function findPixi(): Promise<string | undefined> {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "pixi")),
    join(homedir(), ".pixi", "bin", "pixi"), "/opt/local/bin/pixi", "/usr/local/bin/pixi", "/opt/homebrew/bin/pixi",
  ]
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  return undefined
}

/** The plugin's own Azure CLI: installed with pixi into the data directory from the bundled, locked manifest. */
export class AzTools {
  #installing?: Promise<string>
  constructor(readonly dir: string, private readonly override?: string) {}

  get shimDir(): string { return join(this.dir, "bin") }
  get az(): string { return this.override ?? join(this.shimDir, "az") }

  async stamp(): Promise<string> {
    const [manifest, lock] = await Promise.all([readFile(join(TOOLS_DIR, "pixi.toml"), "utf8"), readFile(join(TOOLS_DIR, "pixi.lock"), "utf8")])
    return createHash("sha256").update(manifest).update(lock).digest("hex").slice(0, 16)
  }

  async ready(): Promise<boolean> {
    if (this.override) return true
    try { return (await readFile(join(this.dir, "installed"), "utf8")).trim() === await this.stamp() } catch { return false }
  }

  /** Installs (or updates) the CLI; resolves with the az path. Safe to call repeatedly. */
  ensure(log: (line: string) => void = () => {}): Promise<string> {
    this.#installing ??= (async () => {
      if (await this.ready()) return this.az
      const pixi = await findPixi()
      if (!pixi) throw new Error("pixi is needed to install the Azure CLI (https://pixi.sh); install it, then run: pixi run tools in the oc-azure folder")
      await mkdir(this.dir, { recursive: true })
      for (const file of ["pixi.toml", "pixi.lock"]) await copyFile(join(TOOLS_DIR, file), join(this.dir, file))
      log("Installing the Azure CLI (about 300 MB, once)…")
      await run(pixi, ["install", "--locked", "--manifest-path", join(this.dir, "pixi.toml")], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 })
      const python = join(this.dir, ".pixi", "envs", "default", "bin", "python")
      await mkdir(this.shimDir, { recursive: true })
      await writeFile(this.az, `#!/bin/sh\n# oc-azure: the plugin's pinned Azure CLI.\nexec "${python}" -W ignore -m azure.cli "$@"\n`, { mode: 0o755 })
      await writeFile(join(this.dir, "installed"), await this.stamp())
      log("Azure CLI installed.")
      return this.az
    })().finally(() => { this.#installing = undefined })
    return this.#installing
  }
}

/** Accounts, vault, permissions, sign-in, the CLI and per-command credentials for one data directory. */
export class AzureService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  readonly tools: AzTools
  #bridge?: PermissionBridge
  #redactorStale = false
  #saving = new Map<string, Serial>()
  #prices = new Map<string, Promise<number | undefined>>()

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    options: { azPath?: string; pricesUrl?: string },
  ) {
    this.tools = new AzTools(join(dir, "tools"), options.azPath)
    this.pricesUrl = options.pricesUrl ?? "https://prices.azure.com/api/retail/prices"
  }
  readonly pricesUrl: string

  static async open(dir: string, options: { azPath?: string; pricesUrl?: string } = {}): Promise<AzureService> {
    const [store, vault, policy] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir)])
    const service = new AzureService(dir, store, vault, policy, options)
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    await RunDir.sweep(join(dir, "run")).catch(() => {})
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id)
      if (!found) throw new Error(`No Azure account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => account.id).join(", ") || "(none; create one with azure_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No Azure account is configured yet. Create one with azure_account_upsert, then azure_signin.")
    throw new Error(`Several Azure accounts exist (${accounts.map(account => account.id).join(", ")}). Name one: AZ_ACCOUNT=<id> az … in the shell, or account=<id> in tools.`)
  }

  async signedIn(account: Account): Promise<boolean> { return this.vault.has(account.id, TOKEN_CACHE) }

  // ------------------------------------------------------------------ per-command CLI state

  baseDir(account: Account): string { return join(this.dir, "az", account.id) }

  /** A private AZURE_CONFIG_DIR for one command: the account's CLI state plus its token cache. */
  async materialize(account: Account, runDir: RunDir): Promise<{ configDir: string; save: () => Promise<void> }> {
    const configDir = runDir.file("azure")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const base = this.baseDir(account)
    for (const name of KEEP) { try { await copyFile(join(base, name), join(configDir, name)) } catch {} }
    const cache = await this.vault.get(account.id, TOKEN_CACHE)
    if (cache) await writeFile(join(configDir, CACHE_FILE), cache, { mode: 0o600 })
    await writeFile(join(configDir, "config"), await this.cliConfig(account, configDir), { mode: 0o600 })
    return { configDir, save: () => this.saveBack(account, configDir, cache) }
  }

  async cliConfig(account: Account, configDir: string): Promise<string> {
    let existing = ""
    try { existing = await readFile(join(configDir, "config"), "utf8") } catch {}
    const lines = existing.split("\n").filter(line => !/^(collect_telemetry|no_color|only_show_errors|login_experience_v2)\s*=/.test(line))
    const core = lines.findIndex(line => line.trim() === "[core]")
    const extra = ["collect_telemetry = no", "login_experience_v2 = off"]
    if (core >= 0) lines.splice(core + 1, 0, ...extra); else lines.unshift("[core]", ...extra, "")
    return lines.join("\n")
  }

  /** After a command: keep refreshed tokens (encrypted) and non-secret CLI state for the next command. */
  async saveBack(account: Account, configDir: string, before: string | undefined): Promise<void> {
    const serial = this.#saving.get(account.id) ?? new Serial()
    this.#saving.set(account.id, serial)
    await serial.run(async () => {
      const base = this.baseDir(account)
      await mkdir(base, { recursive: true, mode: 0o700 })
      for (const name of KEEP) {
        if (name === "config") continue
        try { await copyFile(join(configDir, name), join(base, name)) } catch {}
      }
      try { await copyFile(join(configDir, "config"), join(base, "config")) } catch {}
      let after: string | undefined
      try { after = await readFile(join(configDir, CACHE_FILE), "utf8") } catch {}
      if (after === undefined || after === before) return
      const accounts = (() => { try { return Object.keys((JSON.parse(after) as { Account?: object }).Account ?? {}).length } catch { return -1 } })()
      if (accounts === 0) { await this.vault.delete(account.id, TOKEN_CACHE); await this.store.setDiscovery(account.id, undefined) }
      else if (accounts > 0) await this.vault.set(account.id, TOKEN_CACHE, after)
      await this.refreshRedactor()
    })
  }

  /** Environment for running the plugin's az against an account's state. */
  azEnv(configDir: string): NodeJS.ProcessEnv {
    return {
      ...process.env, AZURE_CONFIG_DIR: configDir, AZURE_CORE_COLLECT_TELEMETRY: "no", AZURE_CORE_NO_COLOR: "true",
      AZURE_CORE_ONLY_SHOW_ERRORS: "true", PYTHONWARNINGS: "ignore",
      PATH: `${this.tools.shimDir}${delimiter}${process.env.PATH ?? ""}`,
    }
  }

  /** Runs az for the plugin itself (discovery, sign-in, SSH setup) with the account's credentials. */
  async az(account: Account, args: readonly string[], options: { timeoutMs?: number; input?: string } = {}): Promise<AzResult> {
    const az = await this.tools.ensure()
    const runDir = await RunDir.create(join(this.dir, "run"))
    try {
      const { configDir, save } = await this.materialize(account, runDir)
      const result = await spawnAz(az, args, this.azEnv(configDir), options)
      await save()
      return result
    } finally { await runDir.remove() }
  }

  async azJson<T>(account: Account, args: readonly string[], options: { timeoutMs?: number } = {}): Promise<T> {
    const result = await this.az(account, [...args, "-o", "json"], options)
    if (result.code !== 0) throw new Error(this.redact(`az ${args.slice(0, 3).join(" ")}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 500)}`))
    return JSON.parse(result.stdout || "null") as T
  }

  redact(text: string): string {
    let result = this.redactor.redact(text)
    for (const pattern of TOKEN_PATTERNS) result = result.replace(new RegExp(pattern.source, "g"), "[REDACTED:token]")
    return result
  }

  // ------------------------------------------------------------------ sign-in

  async startSignIn(account: Account, options: { device?: boolean } = {}): Promise<SignInState> {
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.cancel()
    const az = await this.tools.ensure()
    const runDir = await RunDir.create(join(this.dir, "run"))
    const configDir = runDir.file("azure")
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    await writeFile(join(configDir, "config"), await this.cliConfig(account, configDir), { mode: 0o600 })
    const device = options.device ?? account.auth === "device"
    const secretFile = account.auth === "serviceprincipal" ? await runDir.write("secret", (await this.vault.get(account.id, SP_SECRET)) ?? "") : undefined
    const args = account.auth === "serviceprincipal"
      ? ["login", "--service-principal", "-u", account.clientId!, "--tenant", account.tenant!, "-p", `@${secretFile}`]
      : ["login", ...(account.tenant ? ["--tenant", account.tenant] : []), ...(device ? ["--use-device-code"] : []), "--allow-no-subscriptions"]
    if (account.auth === "serviceprincipal" && !(await this.vault.has(account.id, SP_SECRET))) throw new Error(`${account.id} has no client secret yet: ask the user to enter it (azure_request_secret account=${account.id}).`)
    const env = { ...this.azEnv(configDir), AZURE_CORE_ONLY_SHOW_ERRORS: "false" }
    const child = spawn(az, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    const timeoutMs = 15 * 60_000
    const state: SignInState = {
      account: account.id, status: "waiting", expiresAt: Date.now() + timeoutMs,
      cancel: () => { if (state.status === "waiting") { state.status = "failed"; state.error = "Sign-in cancelled" } try { process.kill(-child.pid!, "SIGTERM") } catch {} },
    }
    this.signIns.set(account.id, state)
    let output = ""
    const watch = (chunk: Buffer) => {
      output += chunk.toString()
      const code = /enter the code ([A-Z0-9-]{6,})/i.exec(output)
      if (code) { state.code = code[1]; state.url = /(https:\/\/\S*devicelogin\S*)/.exec(output)?.[1] ?? "https://microsoft.com/devicelogin" }
      const opened = /browser has been opened at (https:\/\/\S+?)\.?(\s|$)/i.exec(output)
      if (opened && !state.url) state.url = opened[1]
    }
    child.stdout.on("data", watch)
    child.stderr.on("data", watch)
    const timer = setTimeout(() => state.cancel(), timeoutMs)
    child.on("close", async code => {
      clearTimeout(timer)
      try {
        if (code === 0 && state.status === "waiting") {
          await this.saveBack(account, configDir, undefined)
          await this.rediscover(account)
          state.status = "done"
        } else if (state.status === "waiting") {
          state.status = "failed"
          state.error = this.redact(output.trim().split("\n").filter(line => /error|AADSTS|denied|blocked/i.test(line)).slice(-3).join(" ") || `az login exited ${code}`).slice(0, 600)
        }
      } catch (error) { state.status = "failed"; state.error = (error as Error).message }
      finally { await runDir.remove() }
    })
    // Give az a moment to print where to sign in.
    for (let i = 0; i < 40 && !state.url && state.status === "waiting"; i++) await new Promise(resolve => setTimeout(resolve, 250))
    return state
  }

  async signOut(account: Account): Promise<void> {
    await this.vault.delete(account.id, TOKEN_CACHE)
    await rm(this.baseDir(account), { recursive: true, force: true })
    await this.store.setDiscovery(account.id, undefined)
    await this.refreshRedactor()
  }

  // ------------------------------------------------------------------ discovery

  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      const subs = await this.azJson<{ id: string; name: string; isDefault: boolean; state: string; tenantId: string; user?: { name?: string } }[]>(account, ["account", "list", "--all"])
      if (account.subscription) {
        const wanted = subs.find(sub => sub.id === account.subscription || sub.name === account.subscription)
        if (wanted && !wanted.isDefault) { await this.az(account, ["account", "set", "--subscription", wanted.id]); for (const sub of subs) sub.isDefault = sub.id === wanted.id }
      }
      let name: string | undefined
      if (account.auth !== "serviceprincipal") {
        try { name = (await this.azJson<{ displayName?: string }>(account, ["rest", "--url", "https://graph.microsoft.com/v1.0/me?$select=displayName"])).displayName } catch {}
      }
      const vms = (await Promise.all(subs.filter(sub => sub.state === "Enabled").map(sub =>
        this.azJson<RawVm[]>(account, ["vm", "list", "-d", "--subscription", sub.id], { timeoutMs: 120_000 }).then(list => list.map(vm => ({ vm, sub: sub.name }))).catch(() => [])))).flat()
      const running = await Promise.all(vms.filter(({ vm }) => vm.powerState === "VM running").map(async ({ vm, sub }) => summarizeVm(vm, sub, await this.price(vm.hardwareProfile?.vmSize, vm.location, osOf(vm)))))
      discovery = {
        ...(subs[0]?.user?.name && { user: subs[0].user.name }), ...(name && { name }), ...(subs[0]?.tenantId && { tenantId: subs[0].tenantId }),
        subscriptions: subs.map(sub => ({ id: sub.id, name: sub.name, isDefault: sub.isDefault, state: sub.state })),
        running, stoppedVms: vms.length - running.length, checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: this.redact((error as Error).message).slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  /** Pay-as-you-go $/hr for a VM size in a region (Azure Retail Prices API; public, no sign-in). */
  price(size: string | undefined, region: string | undefined, os: "linux" | "windows"): Promise<number | undefined> {
    if (!size || !region) return Promise.resolve(undefined)
    const key = `${size}|${region}|${os}`
    let cached = this.#prices.get(key)
    if (!cached) {
      cached = (async () => {
        try {
          const filter = `serviceName eq 'Virtual Machines' and armSkuName eq '${size}' and armRegionName eq '${region}' and priceType eq 'Consumption'`
          const response = await fetch(`${this.pricesUrl}?$filter=${encodeURIComponent(filter)}`)
          const items = ((await response.json()) as { Items?: { retailPrice: number; skuName: string; productName: string; unitOfMeasure: string }[] }).Items ?? []
          const candidates = items.filter(item => /Hour/.test(item.unitOfMeasure) && !/Spot|Low Priority/i.test(item.skuName) && (os === "windows") === /Windows/i.test(item.productName))
          return candidates.length ? Math.min(...candidates.map(item => item.retailPrice)) : undefined
        } catch { return undefined }
      })()
      this.#prices.set(key, cached)
    }
    return cached
  }

  // ------------------------------------------------------------------ SSH key

  async sshPublicKey(account: Account): Promise<string> {
    let key = await this.vault.get(account.id, SSH_KEY)
    if (!key) {
      const dir = await mkdtemp(join(tmpdir(), "ocaz-"))
      try {
        await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `oc-azure:${account.id}`, "-f", join(dir, "key")])
        key = await readFile(join(dir, "key"), "utf8")
      } finally { await rm(dir, { recursive: true, force: true }) }
      await this.vault.set(account.id, SSH_KEY, key)
      await this.refreshRedactor()
    }
    return publicKeyOf(key, `oc-azure:${account.id}`)
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }

  /** Masks stored secrets and every token inside the CLI token caches. */
  async refreshRedactor(): Promise<void> {
    const entries: [string, string][] = []
    for (const item of await this.vault.values()) {
      if (item.name === TOKEN_CACHE) {
        try {
          const cache = JSON.parse(item.value) as Record<string, Record<string, { secret?: string }>>
          for (const kind of ["AccessToken", "RefreshToken", "IdToken"]) for (const [key, entry] of Object.entries(cache[kind] ?? {})) if (entry.secret) entries.push([`${item.entity}/${kind}/${key.slice(0, 24)}`, entry.secret])
        } catch {}
      } else entries.push([`${item.entity}/${item.name}`, item.value])
    }
    this.redactor.replaceAll(entries)
  }

  dispose(): void { for (const state of this.signIns.values()) state.cancel() }
}

interface RawVm {
  id: string; name: string; resourceGroup: string; location: string; powerState?: string; publicIps?: string; privateIps?: string
  hardwareProfile?: { vmSize?: string }; storageProfile?: { osDisk?: { osType?: string } }; osProfile?: { adminUsername?: string; linuxConfiguration?: unknown }
}
const osOf = (vm: RawVm): "linux" | "windows" => /windows/i.test(vm.storageProfile?.osDisk?.osType ?? "") ? "windows" : "linux"
function summarizeVm(vm: RawVm, subscription: string, costPerHr: number | undefined): VmSummary {
  return {
    name: vm.name, resourceGroup: vm.resourceGroup, subscription, size: vm.hardwareProfile?.vmSize ?? "?", location: vm.location, os: osOf(vm), id: vm.id,
    ...(vm.publicIps && { publicIp: vm.publicIps.split(",")[0] }), ...(vm.privateIps && { privateIp: vm.privateIps.split(",")[0] }),
    ...(vm.osProfile?.adminUsername && { adminUser: vm.osProfile.adminUsername }), ...(costPerHr !== undefined && { costPerHr }),
  }
}

export function spawnAz(az: string, args: readonly string[], env: NodeJS.ProcessEnv, options: { timeoutMs?: number; input?: string } = {}): Promise<AzResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(az, args, { env, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true })
    if (options.input !== undefined) child.stdin!.end(options.input)
    let stdout = "", stderr = ""
    child.stdout!.on("data", chunk => { if (stdout.length < 20_000_000) stdout += chunk })
    child.stderr!.on("data", chunk => { if (stderr.length < 1_000_000) stderr += chunk })
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL") } catch {} }, options.timeoutMs ?? 120_000)
    child.on("error", error => { clearTimeout(timer); reject(error) })
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

/** Public key line of an OpenSSH ed25519 private key. */
export function publicKeyOf(privateKey: string, comment?: string): string {
  const body = Buffer.from(privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64")
  let offset = 15
  const string = () => { const length = body.readUInt32BE(offset); const value = body.subarray(offset + 4, offset + 4 + length); offset += 4 + length; return value }
  string(); string(); string()
  offset += 4
  const blob = string()
  const type = blob.subarray(4, 4 + blob.readUInt32BE(0)).toString()
  return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`
}

export const exists = async (path: string) => { try { await stat(path); return true } catch { return false } }
export { dirname, readdir }
