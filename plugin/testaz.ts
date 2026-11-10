// Test helper: a fake `az` (a small node script) that behaves like the CLI where the plugin cares — it reads and writes
// AZURE_CONFIG_DIR (azureProfile.json, msal_token_cache.json), "signs in" by writing a token cache, refreshes tokens on
// use, prints access tokens, lists subscriptions and VMs — plus a fake Azure Retail Prices API.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path")
const dir = process.env.AZURE_CONFIG_DIR
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.FAKE_AZ_STATE, "utf8"))
const log = (line) => fs.appendFileSync(process.env.FAKE_AZ_STATE + ".log", JSON.stringify({ args, dir }) + "\n")
log()
const cacheFile = path.join(dir, "msal_token_cache.json"), profileFile = path.join(dir, "azureProfile.json")
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined } }
const token = () => "eyJ" + "fakeheader0123456789" + ".eyJ" + "fakepayload" + Math.random().toString(36).slice(2, 12) + ".signature0123456789abc"
const out = (value) => { process.stdout.write(typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n"); process.exit(0) }
const fail = (message) => { process.stderr.write("ERROR: " + message + "\n"); process.exit(1) }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const subs = [{ id: "11111111-1111-1111-1111-111111111111", name: "dev", state: "Enabled", tenantId: "t-1" }, { id: "22222222-2222-2222-2222-222222222222", name: "prod", state: "Enabled", tenantId: "t-1" }]
if (args[0] === "version") out({ "azure-cli": "2.92.0" })
if (args[0] === "login") {
  const device = args.includes("--use-device-code")
  if (device) process.stderr.write("To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-1234 to authenticate.\n")
  else process.stderr.write("A web browser has been opened at https://login.microsoftonline.com/t-1/oauth2/v2.0/authorize. Please continue the login in the web browser.\n")
  const deadline = Date.now() + 10000
  const wait = () => {
    if (fs.existsSync(process.env.FAKE_AZ_STATE + ".approve")) {
      fs.unlinkSync(process.env.FAKE_AZ_STATE + ".approve")
      const user = state.user
      fs.writeFileSync(cacheFile, JSON.stringify({ Account: { a: { username: user } }, AccessToken: { at: { secret: token() } }, RefreshToken: { rt: { secret: "1.A" + "r".repeat(120) + Date.now() } }, IdToken: {} }))
      fs.writeFileSync(profileFile, JSON.stringify({ subscriptions: subs.map((sub, i) => ({ ...sub, isDefault: i === 0, user: { name: user, type: "user" } })) }))
      out(subs)
    }
    if (Date.now() > deadline) fail("login timed out")
    setTimeout(wait, 50)
  }
  return wait()
}
const cache = read(cacheFile)
if (!cache || !Object.keys(cache.Account || {}).length) fail("Please run 'az login' to setup account.")
// Using the CLI refreshes the access token (the cache changes, like the real CLI's).
cache.AccessToken = { at: { secret: token() } }
fs.writeFileSync(cacheFile, JSON.stringify(cache))
const profile = read(profileFile) || { subscriptions: [] }
if (args[0] === "account" && args[1] === "list") out(profile.subscriptions)
if (args[0] === "account" && args[1] === "show") out(profile.subscriptions.find(s => s.isDefault))
if (args[0] === "account" && args[1] === "set") { const want = opt("--subscription") || opt("-s"); for (const s of profile.subscriptions) s.isDefault = s.id === want || s.name === want; fs.writeFileSync(profileFile, JSON.stringify(profile)); process.exit(0) }
if (args[0] === "account" && args[1] === "get-access-token") out({ accessToken: cache.AccessToken.at.secret, expiresOn: "2030-01-01" })
if (args[0] === "logout") { fs.writeFileSync(cacheFile, JSON.stringify({ Account: {}, AccessToken: {}, RefreshToken: {}, IdToken: {} })); process.exit(0) }
if (args[0] === "rest" && (opt("--url") || "").includes("graph.microsoft.com")) out({ displayName: "Pat Lee" })
if (args[0] === "vm" && args[1] === "list") {
  const sub = opt("--subscription") || "dev"
  out(state.vms.filter(vm => vm.sub === sub || subs.find(s => s.id === sub)?.name === vm.sub).map(vm => ({ id: "/subscriptions/x/resourceGroups/" + vm.rg + "/providers/Microsoft.Compute/virtualMachines/" + vm.name, name: vm.name, resourceGroup: vm.rg, location: "westus2", powerState: vm.power, publicIps: vm.ip || "", privateIps: "10.0.0.4", hardwareProfile: { vmSize: vm.size }, storageProfile: { osDisk: { osType: vm.os || "Linux" } }, osProfile: { adminUsername: state.vmUser } })))
}
if (args[0] === "vm" && args[1] === "user" && args[2] === "update") { fs.appendFileSync(state.authorizedKeys, opt("--ssh-key-value") + "\n"); process.exit(0) }
if (args[0] === "group" && args[1] === "list") out([{ name: "rg-a" }, { name: "rg-b" }])
if (args[0] === "group" && args[1] === "delete") out("deleted " + opt("-n"))
if (args[0] === "vm" && args[1] === "create") out({ name: opt("-n"), powerState: "VM running" })
fail("fake az: unsupported " + args.join(" "))
`

export interface FakeAz {
  readonly az: string
  readonly pricesUrl: string
  /** Lets a waiting `az login` finish as the configured user. */
  approve(): Promise<void>
  /** Every invocation: its arguments and AZURE_CONFIG_DIR. */
  calls(): Promise<{ args: string[]; dir: string }[]>
  stop(): Promise<void>
}

export async function startFakeAz(options: { user?: string; vms?: { name: string; rg: string; sub: string; size: string; power: string; ip?: string; os?: string }[]; vmUser?: string; authorizedKeys?: string } = {}): Promise<FakeAz> {
  const dir = await mkdtemp(join(tmpdir(), "ocaz-fake-"))
  const stateFile = join(dir, "state.json")
  await writeFile(stateFile, JSON.stringify({ user: options.user ?? "pat@acme.example", vms: options.vms ?? [], vmUser: options.vmUser ?? "azureuser", authorizedKeys: options.authorizedKeys ?? join(dir, "keys") }))
  const az = join(dir, "az")
  await writeFile(az, `#!/bin/sh\nFAKE_AZ_STATE='${stateFile}' exec '${process.execPath}' '${join(dir, "az.cjs")}' "$@"\n`)
  await writeFile(join(dir, "az.cjs"), SCRIPT)
  await chmod(az, 0o755)
  const prices = createServer((req, res) => {
    const filter = decodeURIComponent(new URL(req.url!, "http://x").searchParams.get("$filter") ?? "")
    const size = /armSkuName eq '([^']+)'/.exec(filter)?.[1]
    const table: Record<string, number> = { Standard_B2s: 0.0416, Standard_D4s_v5: 0.192 }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ Items: size && table[size] ? [
      { retailPrice: table[size], skuName: size.replace("Standard_", ""), productName: "Virtual Machines BS Series", unitOfMeasure: "1 Hour" },
      { retailPrice: table[size] * 2, skuName: size.replace("Standard_", ""), productName: "Virtual Machines BS Series Windows", unitOfMeasure: "1 Hour" },
      { retailPrice: table[size] / 5, skuName: `${size.replace("Standard_", "")} Spot`, productName: "Virtual Machines BS Series", unitOfMeasure: "1 Hour" },
    ] : [] }))
  })
  await new Promise<void>(resolve => prices.listen(0, "127.0.0.1", resolve))
  return {
    az, pricesUrl: `http://127.0.0.1:${(prices.address() as { port: number }).port}/api/retail/prices`,
    approve: () => writeFile(`${stateFile}.approve`, "1"),
    async calls() {
      const { readFile } = await import("node:fs/promises")
      try { return (await readFile(`${stateFile}.log`, "utf8")).trim().split("\n").map(line => JSON.parse(line)) } catch { return [] }
    },
    async stop() { await new Promise(resolve => prices.close(resolve)); await rm(dir, { recursive: true, force: true }) },
  }
}
