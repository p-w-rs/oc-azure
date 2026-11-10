import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { startFakeAz, type FakeAz } from "./testaz.js"
import { startSshd, type TestSshd } from "./testsshd.js"

const dirs: string[] = []
let fake: FakeAz
let sshd: TestSshd
before(async () => {
  sshd = await startSshd()
  fake = await startFakeAz({
    user: "pat@acme.example", vmUser: sshd.user, authorizedKeys: sshd.authorizedKeys,
    vms: [
      { name: "dev-box", rg: "rg-dev", sub: "dev", size: "Standard_B2s", power: "VM running", ip: "127.0.0.1" },
      { name: "win-agent", rg: "rg-build", sub: "dev", size: "Standard_D4s_v5", power: "VM running", os: "Windows" },
      { name: "old-box", rg: "rg-dev", sub: "prod", size: "Standard_B2s", power: "VM deallocated" },
    ],
  })
})
after(async () => { await fake.stop(); await sshd.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ocaz-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], before: [] as any[], after: [] as any[], shell: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const ctx = {
    options: { dataDirectory: dir, azPath: fake.az, pricesUrl: fake.pricesUrl, ...options },
    session: { get: async () => ({ parentID: undefined }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (name: string, callback: any) => registration(name === "execute.before" ? hooks.before : hooks.after, callback),
    },
    shell: { hook: async (_: string, callback: any) => registration(hooks.shell, callback) },
    skill: { transform: async (callback: any) => { callback({ add: (skill: any) => skills.push(skill) }); return { dispose: async () => { skills.length = 0 } } } },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const context = (agent: string) => ({ sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} })
  const finish = async (event: any) => { for (const hook of hooks.after) await hook(event); return event }
  const call = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = context(agent)
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    await finish(event)
    if (event.status === "error") throw event.error
    const text = event.result.content
    try { return JSON.parse(text) } catch { return text }
  }
  /** Runs a command through the native shell path: execute.before, shell create.before, a real sh, execute.after. */
  const shell = async (command: string, agent = "build") => {
    const c = context(agent)
    const input = { command, description: "test" }
    for (const hook of hooks.before) await hook({ tool: "shell", ...c, input })
    const create = { command, cwd: dir, timeout: 60_000, shell: "/bin/sh", env: {} as Record<string, string | undefined> }
    for (const hook of hooks.shell) await hook(create)
    const { exit, output } = await new Promise<{ exit: number; output: string }>((resolve, reject) => {
      // The fake az stands in for the plugin's own CLI on PATH.
      const child = spawn("/bin/sh", ["-c", command.replace(/(^|[;&|]\s*|AZ_ACCOUNT=\S+\s+)az /g, `$1${fake.az} `)], { cwd: dir, env: { ...process.env, ...create.env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
      let output = ""
      child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
      child.on("error", reject)
      child.on("close", code => resolve({ exit: code ?? -1, output }))
    })
    const event = await finish({ tool: "shell", id: c.id, input, status: "completed", result: { output: { exit, truncated: false, output, status: "completed" }, content: [{ type: "text", text: output }], metadata: { exit } } })
    return { exit, text: event.result.content[0].text as string, env: create.env }
  }
  const signIn = async (id = "work", input: Record<string, unknown> = {}) => {
    await call("azure_account_upsert", { id, tenant: "acme.example", ...input })
    const started = call("azure_signin", { account: id, wait: 20 })
    setTimeout(() => void fake.approve(), 300)
    return started
  }
  return { dir, tools, skills, prompts, call, shell, signIn, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 7)
  assert.equal(h.skills[0]!.id, "azure")
  assert.match(h.skills[0]!.content, /Stopped ≠ deallocated/)
  assert.match(h.tools.get("azure_list")!.description, /No Azure accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { pricesUrl: "ftp://x" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ azPath: 1 }), /string/)
})

test("browser sign-in through az; inventory with subscriptions, running VMs, list prices", async () => {
  const h = await host()
  const signed = await h.signIn()
  assert.equal(signed.status, "done")
  assert.deepEqual(signed.subscriptions, ["dev", "prod"])
  const login = (await fake.calls()).find(call => call.args[0] === "login")!
  assert.deepEqual(login.args, ["login", "--tenant", "acme.example", "--allow-no-subscriptions"])
  await new Promise(r => setTimeout(r, 30))
  const description = h.tools.get("azure_list")!.description
  assert.match(description, /work: Pat Lee \(pat@acme\.example\); subscriptions dev, prod \(default dev\)/)
  assert.match(description, /running: dev-box \(dev\/rg-dev, Standard_B2s, ~\$0\.04\/hr, ssh alias az-work-dev-box\)/, "Linux pay-as-you-go price, not Spot or Windows")
  assert.match(description, /running: win-agent \(dev\/rg-build, Standard_D4s_v5, ~\$0\.38\/hr, Windows\)/)
  assert.match(description, /Running VMs cost about \$0\.43\/hr together/)
  const cache = (await (await h.vault()).get("work", "az-token-cache"))!
  assert.match(cache, /RefreshToken/)
  assert.ok(!JSON.stringify(await h.call("azure_list", {})).includes("eyJ"), "no tokens in tool output")
})

test("the agent's az: signed in per command, permissions by what it does, tokens saved and masked", async () => {
  const h = await host()
  await h.signIn()
  const shown = await h.shell("az account show")
  assert.equal(shown.exit, 0, shown.text)
  assert.match(shown.text, /pat@acme\.example/)
  assert.match(shown.env.AZURE_CONFIG_DIR!, /run/, "a private CLI dir for this command")
  assert.deepEqual(h.prompts, [])
  const token = await h.shell("az account get-access-token")
  assert.doesNotMatch(token.text, /eyJfake/, "tokens the CLI prints are masked")
  assert.match(token.text, /\[REDACTED:token\]/)
  // The CLI refreshed its tokens during those commands; the plugin keeps the new cache.
  const cache = (await (await h.vault()).get("work", "az-token-cache"))!
  const latest = JSON.parse(cache).AccessToken.at.secret as string
  const calls = await fake.calls()
  assert.notEqual(new Set(calls.map(call => call.dir)).size, 1, "each command had its own directory")
  // A delete asks; rejecting it runs the command signed out.
  const rejecting = await host("reject")
  await rejecting.signIn()
  const denied = await rejecting.shell("az group delete -n rg-a --yes")
  assert.notEqual(denied.exit, 0)
  assert.match(denied.text, /Please run 'az login'/)
  assert.match(denied.text, /az for work was not allowed \(resources-delete\).*ran signed out/)
  assert.deepEqual((rejecting.prompts as { action: string }[]).map(p => p.action), ["oc-azure.resources-delete"])
  // Several az calls in one command: the most sensitive is asked.
  h.prompts.length = 0
  await h.shell("az group list -o tsv && az vm create -g rg -n x --image Ubuntu2404 && az group delete -n rg --yes")
  assert.deepEqual((h.prompts as { action: string }[]).map(p => p.action), ["oc-azure.resources-spend", "oc-azure.resources-delete"])
  // Plain commands get nothing; denied tables are respected per agent.
  assert.deepEqual((await h.shell("echo hello")).env, {})
  await (await h.policy()).setCells([{ entity: "work", row: { agent: "plan" }, capability: "resources-read", effect: "deny" }])
  assert.match((await h.shell("az group list", "plan")).text, /not allowed \(resources-read\)/)
  assert.ok(latest.startsWith("eyJ"))
  assert.deepEqual((await readdir(join(h.dir, "az", "work"))).sort().includes("azureProfile.json"), true, "non-secret CLI state kept between commands")
  assert.doesNotMatch(await readFile(join(h.dir, "az", "work", "azureProfile.json"), "utf8"), /secret/)
})

test("several accounts: AZ_ACCOUNT picks; otherwise the agent is told to choose", async () => {
  const h = await host()
  await h.signIn("work")
  await h.call("azure_account_upsert", { id: "other", tenant: "other.example" })
  const unclear = await h.shell("az account show")
  assert.match(unclear.text, /Several Azure accounts exist .*AZ_ACCOUNT=<id>/)
  const chosen = await h.shell("AZ_ACCOUNT=work az account show")
  assert.match(chosen.text, /pat@acme\.example/)
  const none = await h.shell("AZ_ACCOUNT=other az account show")
  assert.match(none.text, /other is not signed in/)
})

test("SSH into a Linux VM: key added with az vm user update, then the agent's own ssh", async () => {
  const h = await host()
  await h.signIn()
  const setup = await h.call("azure_ssh_setup", { vm: "dev-box" })
  assert.equal(setup.alias, "az-work-dev-box")
  assert.deepEqual(h.prompts.map(p => p.action), ["oc-azure.resources-admin"])
  // The fake sshd listens on its own port; point the generated config at it.
  const ran = await h.shell(`sed -i.bak 's/^  HostName 127.0.0.1/  HostName 127.0.0.1\\n  Port ${sshd.port}/' "$AZURE_SSH_CONFIG" 2>/dev/null || sed -i '' 's/^  HostName 127.0.0.1/  HostName 127.0.0.1\\
  Port ${sshd.port}/' "$AZURE_SSH_CONFIG"; ssh -F "$AZURE_SSH_CONFIG" az-work-dev-box 'echo VM_OK'`)
  assert.match(ran.text, /VM_OK/, ran.text)
  const windows = await h.shell(`ssh -F "$AZURE_SSH_CONFIG" az-work-win-agent true`)
  assert.match(windows.text, /runs Windows; use az vm run-command invoke/)
  await assert.rejects(h.call("azure_ssh_setup", { vm: "old-box" }), /No running VM/)
})

test("GUI admin: device-code sign-in, default subscription, export and import", async () => {
  const h = await host()
  await h.rpc().createAccount({ id: "work", auth: "device", tenant: "acme.example" })
  const started = await h.rpc().signIn({ id: "work" })
  assert.equal(started.code, "ABCD-1234")
  assert.equal((await h.rpc().state({ sessionID: "s" })).accounts[0].signIn.code, "ABCD-1234")
  await fake.approve()
  for (let i = 0; i < 200 && !(await h.rpc().state({})).accounts[0].signedIn; i++) await new Promise(r => setTimeout(r, 30))
  for (let i = 0; i < 200 && !(await h.rpc().state({})).accounts[0].subscriptions; i++) await new Promise(r => setTimeout(r, 30))
  const state = await h.rpc().state({})
  assert.equal(state.cli, "ready")
  assert.deepEqual(state.accounts[0].subscriptions.map((sub: { name: string }) => sub.name), ["dev", "prod"])
  await h.rpc().updateAccount({ id: "work", subscription: "prod" })
  assert.equal((await h.rpc().state({})).accounts[0].subscriptions.find((sub: { isDefault: boolean }) => sub.isDefault).name, "prod")
  assert.ok(!JSON.stringify(state).includes("eyJ"), "no tokens in the GUI")
  const exported = await h.rpc().exportBundle({ passphrase: "export passphrase 1" })
  const other = await host()
  await other.rpc().applyImport({ content: exported.content, passphrase: "export passphrase 1", mode: "merge" })
  const moved = await other.shell("az account show")
  assert.match(moved.text, /pat@acme\.example/, "the imported sign-in works on the new install")
  await h.rpc().signOut({ id: "work" })
  assert.equal((await h.rpc().state({})).accounts[0].signedIn, false)
})
