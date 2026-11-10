// End-to-end check against a real OpenCode CLI (pinned) in an isolated home, a scripted local model (not a real LLM)
// and a fake Azure CLI. Verifies: tools and the skill load, sign-in through az completes, the inventory reaches the
// model, the agent's own az commands are signed in per command, a billable create goes through the permission prompt,
// tokens the CLI prints are masked, and plain commands get nothing. --snapshot loads a verified installed snapshot instead of the checkout.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFakeAz } from "../plugin/testaz.ts"

const OPENCODE_VERSION = "2.2.6"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cliPackage = `@opencode/cli-${process.platform}-${process.arch}`
const binary = path.join(root, ".local", "host", "node_modules", cliPackage, "bin", "opencode")
export async function ensureCli() {
  try { await access(binary); return binary } catch {}
  console.log(`Installing ${cliPackage}@${OPENCODE_VERSION} into .local/host ...`)
  await mkdir(path.join(root, ".local", "host"), { recursive: true })
  const result = spawnSync("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--prefix", path.join(root, ".local", "host"), "--cache", path.join(root, ".local", "npm-cache"), `${cliPackage}@${OPENCODE_VERSION}`], { stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Could not install ${cliPackage}@${OPENCODE_VERSION}`)
  return binary
}
if (process.argv.includes("--install-cli")) { await ensureCli(); process.exit(0) }
await ensureCli()

const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "oc-azure-smoke-"))
const home = path.join(base, "home"), workspace = path.join(base, "workspace")
await mkdir(workspace, { recursive: true }); await mkdir(path.join(home, "config", "opencode"), { recursive: true })
const fakeAz = await startFakeAz({ user: "pat@acme.example", vms: [{ name: "dev-box", rg: "rg-dev", sub: "dev", size: "Standard_B2s", power: "VM running", ip: "10.1.2.3" }] })
// The agent calls plain `az`; put the fake first on PATH.
const azBin = path.join(base, "azbin")
await mkdir(azBin, { recursive: true })
await writeFile(path.join(azBin, "az"), `#!/bin/sh\nexec "${fakeAz.az}" "$@"\n`, { mode: 0o755 })

let pluginPath = root
if (process.argv.includes("--snapshot")) {
  process.env.XDG_DATA_HOME = path.join(home, "data")
  const { deploy, verifyRelease } = await import("./install.mjs")
  pluginPath = await deploy()
  await verifyRelease(pluginPath)
  console.log(`Using snapshot ${pluginPath}`)
}

const calls = [
  { name: "azure_account_upsert", input: { id: "work", tenant: "acme.example", label: "Work" } },
  { name: "azure_signin", input: { account: "work", wait: 30 } },
  { name: "shell", input: { description: "Who am I", command: "az account show --query user.name -o tsv" } },
  { name: "shell", input: { description: "Token", command: "az account get-access-token" } },
  { name: "shell", input: { description: "Create a VM", command: "az vm create -g rg-me -n scratch1 --image Ubuntu2404 --size Standard_B2s" } },
  { name: "shell", input: { description: "Plain command", command: "env | grep -c '^AZURE_CONFIG_DIR=' || true" } },
]
const toolResults = []
const descriptions = []
const prompts = []
let modelRequests = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const part of req) chunks.push(part)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400); res.end(); return }
  const main = Array.isArray(body.tools) && body.tools.some(tool => tool.function?.name === "azure_list")
  if (main) {
    modelRequests++
    descriptions.push(body.tools.find(tool => tool.function?.name === "azure_list").function.description)
    prompts.push(JSON.stringify(body.messages ?? []))
    toolResults.length = 0
    for (const message of body.messages ?? []) if (message.role === "tool") toolResults.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  }
  const call = main ? calls.shift() : undefined
  // The user opens the sign-in link the agent passed on, and approves.
  if (call?.name === "azure_signin") setTimeout(() => void fakeAz.approve(), 2000)
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: `c${modelRequests}`, object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
  const events = call
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelRequests}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: main ? "OC_AZURE_SMOKE_COMPLETE" : "Smoke" }), chunk({}, "stop")]
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "probe/probe",
  plugins: [{ package: pluginPath, options: { azPath: fakeAz.az, pricesUrl: fakeAz.pricesUrl } }],
  providers: { probe: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-not-a-secret" },
    models: { probe: { limit: { context: 32000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}))
const env = {
  HOME: home, TMPDIR: home, PATH: [azBin, path.join(root, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
}
let stdout = "", stderr = ""
const child = spawn(binary, ["run", "--standalone", "--auto", "--format", "json", "--model", "probe/probe", "oc-azure smoke"], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", data => { stdout += data }); child.stderr.on("data", data => { stderr += data })
const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 150_000)
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) })
clearTimeout(timer); server.close(); await fakeAz.stop()

const logs = path.join(root, ".local", "smoke-host.log")
await mkdir(path.dirname(logs), { recursive: true })
await writeFile(logs, `${stdout}\n----- stderr -----\n${stderr}`, { mode: 0o600 })
try {
  assert.equal(code, 0, `opencode exited ${code}; see ${logs}`)
  assert.equal(calls.length, 0, "every scripted call was made")
  assert.ok(stdout.includes("OC_AZURE_SMOKE_COMPLETE"), "run completed")
  assert.doesNotMatch(stderr, /\[oc-azure\] (disabled|could not|tool reload failed|skill not registered)/, "no plugin warnings")
  assert.match(descriptions[0], /No Azure accounts are configured yet/)
  assert.match(descriptions.at(-1), /work: Pat Lee \(pat@acme\.example\); subscriptions dev, prod/, "inventory refreshed live")
  assert.match(descriptions.at(-1), /running: dev-box .*ssh alias az-work-dev-box/)
  assert.match(prompts[0], /azure/, "the azure skill is offered")
  const all = toolResults.join("\n")
  assert.match(all, /"status": "done"/, "sign-in completed")
  assert.match(all, /pat@acme\.example/, "the agent's az was signed in")
  assert.doesNotMatch(all, /eyJfake/, "tokens the CLI printed are masked")
  assert.match(all, /scratch1/, "billable create ran after the prompt was approved")
  assert.match(toolResults.at(-1), /^0\b|"0\\n|\b0\n/, "a plain command gets nothing")
  if (pluginPath !== root) await (await import("./install.mjs")).verifyRelease(pluginPath)
  console.log(`oc-azure host smoke passed${pluginPath !== root ? " from a snapshot" : ""} (OpenCode ${OPENCODE_VERSION}, ${process.platform}-${process.arch}, ${modelRequests} model requests).`)
  await rm(base, { recursive: true, force: true })
} catch (error) {
  console.error(`Smoke failed. Scratch home kept at ${base}; logs at ${logs}`)
  throw error
}
