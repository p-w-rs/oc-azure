import type { ToolContext } from "@opencode/plugin/promise/tool"
import { mergeAccount, normalizeAccount, SP_SECRET, validAccountId, vmAlias, type Account, type Discovery } from "./model.js"
import type { AzureService } from "./service.js"
import { SSH_CONFIG_VAR } from "./supply.js"

export const TOOL_NAMES = [
  "azure_list", "azure_account_upsert", "azure_account_remove", "azure_signin", "azure_refresh", "azure_ssh_setup", "azure_request_secret",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id (optional when there is only one account)" }
const money = (value: number) => `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString("en-US")}`

export const USAGE = [
  "Load the 'azure' skill before non-trivial Azure work (resources, VMs, Entra/Graph, DevOps, AI, costs).",
  "Use the Azure CLI in your shell: az … (signed in per account for that command; each az call is checked against your permissions: reads run, creating/starting billable things, deleting and role/directory changes may ask). Several accounts: AZ_ACCOUNT=<id> az …",
  `Work inside a Linux VM with a public IP: ssh -F "$${SSH_CONFIG_VAR}" <alias> 'cmd'; rsync -e "ssh -F '$${SSH_CONFIG_VAR}'" src <alias>:dst. azure_ssh_setup adds the plugin's key to a VM.`,
  "VMs cost money while running: state the size and estimated $/hr before creating or starting one; deallocate VMs you started when the work is done.",
].join("\n")

function describe(account: Account, discovery: Discovery | undefined): string[] {
  const subs = discovery?.subscriptions ?? []
  const current = subs.find(sub => sub.isDefault)
  const head = `  ${account.id}: ${discovery?.checkedAt && subs.length ? `${discovery.name ?? discovery.user ?? "signed in"}${discovery.user && discovery.name ? ` (${discovery.user})` : ""}; subscriptions ${subs.map(sub => sub.name).join(", ")}${current ? ` (default ${current.name})` : ""}` : discovery?.checkedAt ? "signed in, no subscriptions" : "not signed in"}${account.label ? ` — ${account.label}` : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 140)}]` : ""}`
  const running = (discovery?.running ?? []).map(vm =>
    `    running: ${vm.name} (${vm.subscription}/${vm.resourceGroup}, ${vm.size}${vm.costPerHr !== undefined ? `, ~${money(vm.costPerHr)}/hr` : ""}${vm.os === "windows" ? ", Windows" : vm.publicIp ? `, ssh alias ${vmAlias(account.id, vm)}` : ", no public IP"})`)
  return [head, ...running.slice(0, 20), ...(running.length > 20 ? [`    …and ${running.length - 20} more running`] : [])]
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No Azure accounts are configured yet. Create one with azure_account_upsert, then azure_signin."
  const burn = accounts.reduce((sum, account) => sum + (discovery[account.id]?.running ?? []).reduce((s, vm) => s + (vm.costPerHr ?? 0), 0), 0)
  return ["Azure accounts (Microsoft identities; az in your shell uses them):", ...accounts.flatMap(account => describe(account, discovery[account.id])),
    ...(burn > 0 ? [`  Running VMs cost about ${money(burn)}/hr together (list prices, as of the last check). Many belong to colleagues: only stop VMs you started or the user names.`] : [])].join("\n")
}

export function createTools(service: AzureService): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })

  return [
    {
      name: "azure_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for live details and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }, context) => {
        const settings = await service.store.settings()
        const chosen = input.account ? [await service.pick(input.account)] : await service.store.list()
        const accounts = await Promise.all(chosen.map(async account => {
          const signedIn = await service.signedIn(account)
          const discovery = signedIn ? await service.rediscover(account) : await service.store.discovery(account.id)
          const may = Object.fromEntries(await Promise.all(["resources-read", "resources-write", "resources-spend", "resources-delete", "identity-admin", "ai-spend", "devops-write", "ssh"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          const signIn = service.signIns.get(account.id)
          return {
            id: account.id, auth: account.auth, ...(account.tenant && { tenant: account.tenant }), ...(account.label && { label: account.label }), signedIn,
            ...(discovery?.user && { user: discovery.user }), ...(discovery?.name && { name: discovery.name }),
            subscriptions: discovery?.subscriptions ?? [], stoppedVms: discovery?.stoppedVms ?? 0,
            running: (discovery?.running ?? []).map(vm => ({ ...vm, ...(vm.os === "linux" && vm.publicIp && { sshAlias: vmAlias(account.id, vm) }) })),
            ...(signIn?.status === "waiting" && { signIn: signIn.code ? `waiting: code ${signIn.code} at ${signIn.url}` : `waiting for the user in the browser` }),
            ...(discovery?.error && { problem: discovery.error }), ...(settings.defaultAccount === account.id && { default: true }), youMay: may,
          }
        }))
        return json({ accounts, cli: (await service.tools.ready()) ? "ready" : "not installed yet (installs on first use)", usage: USAGE })
      },
    },
    {
      name: "azure_account_upsert",
      description: () => "Create or update an Azure account (fields merge; null clears): one Microsoft identity in one tenant. auth: browser (default; SSO and MFA), device (code on any device, for remote servers) or serviceprincipal (clientId + tenant; the user enters the secret). tenant: domain or directory id. subscription: default for az commands. Never pass secrets here.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. work" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          auth: { type: "string", enum: ["browser", "device", "serviceprincipal"] }, tenant: { type: ["string", "null"] },
          clientId: { type: ["string", "null"] }, subscription: { type: ["string", "null"] }, label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target) }
        if (existing && (existing.tenant !== saved.tenant || existing.auth !== saved.auth || existing.clientId !== saved.clientId)) await service.signOut(saved)
        const signedIn = await service.signedIn(saved)
        return json({ saved, signedIn, ...(!signedIn && { next: saved.auth === "serviceprincipal" && !(await service.vault.has(saved.id, SP_SECRET)) ? `ask for the secret: azure_request_secret account=${saved.id}, then azure_signin` : `sign in: azure_signin account=${saved.id}` }) })
      },
    },
    {
      name: "azure_account_remove",
      description: () => "Delete an Azure account from this plugin with its stored sign-in and permission settings. Asks the user by default. Does not change anything in Azure.",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.cancel()
        service.signIns.delete(account.id)
        await service.signOut(account)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        await service.policy.removeEntity(account.id)
        return json({ removed: account.id })
      },
    },
    {
      name: "azure_signin",
      description: () => "Start the Microsoft sign-in for an Azure account. browser: a sign-in page opens in the browser on this computer; device (or device=true): the user enters a code at microsoft.com/devicelogin on any device. Completes in the background; wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, device: { type: "boolean" }, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; device?: boolean; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account, { ...(input.device !== undefined && { device: input.device }) })
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: state.code
            ? `On any device, open ${state.url} and enter the code ${state.code}, then sign in with your ${account.tenant ?? "work"} Microsoft account.`
            : `A Microsoft sign-in page opened in the browser on this computer${state.url ? ` (${state.url})` : ""}. Sign in${account.tenant ? ` to ${account.tenant}` : ""} and approve; then return here. If no page opened, sign in again with device=true.` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { user: discovery.user, name: discovery.name, subscriptions: discovery.subscriptions?.map(sub => sub.name), running: discovery.running?.length ?? 0, ...(discovery.error && { problem: discovery.error }) }),
        })
      },
    },
    {
      name: "azure_refresh",
      description: () => "Check an account again: who is signed in, subscriptions, running VMs with estimated cost.",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        return json({ account: account.id, ...(await service.rediscover(account)) })
      },
    },
    {
      name: "azure_ssh_setup",
      description: () => `Add the plugin's SSH key to a Linux VM (az vm user update; keeps existing keys, does not restart the VM) so ssh -F "$${SSH_CONFIG_VAR}" <alias> works. Needs rights to change the VM; asks first by default.`,
      input: {
        type: "object",
        properties: { account: ACCOUNT, vm: { type: "string", description: "VM name or alias" }, resourceGroup: { type: "string" }, subscription: { type: "string" }, user: { type: "string", description: "Login user (default: the VM's admin user)" } },
        required: ["vm"], additionalProperties: false,
      },
      execute: async (input: { account?: string; vm: string; resourceGroup?: string; subscription?: string; user?: string }, context) => {
        const account = await service.pick(input.account)
        let running = (await service.store.discovery(account.id))?.running ?? []
        const match = (list: typeof running) => list.filter(vm => (vm.name === input.vm || vmAlias(account.id, vm) === input.vm) && (!input.resourceGroup || vm.resourceGroup.toLowerCase() === input.resourceGroup.toLowerCase()) && (!input.subscription || vm.subscription === input.subscription))
        if (!match(running).length) running = (await service.rediscover(account)).running ?? []
        const found = match(running)
        if (found.length !== 1) throw new Error(found.length ? `Several VMs match: ${found.map(vm => `${vm.subscription}/${vm.resourceGroup}/${vm.name}`).join(", ")}; pass resourceGroup/subscription.` : `No running VM ${JSON.stringify(input.vm)} in ${account.id}. Start it first, or check azure_list.`)
        const vm = found[0]!
        if (vm.os === "windows") throw new Error(`${vm.name} runs Windows; SSH is for Linux VMs.`)
        const user = input.user ?? vm.adminUser ?? "azureuser"
        await check(context, "resources-admin", account.id, { operation: `add the plugin's SSH key for ${user} on VM ${vm.name} (existing keys kept)`, vm: vm.id })
        const key = await service.sshPublicKey(account)
        const result = await service.az(account, ["vm", "user", "update", "--ids", vm.id, "-u", user, "--ssh-key-value", key, "-o", "none"], { timeoutMs: 600_000 })
        if (result.code !== 0) throw new Error(service.redact(`az vm user update failed: ${(result.stderr || result.stdout).trim().slice(-600)}`))
        const alias = vmAlias(account.id, vm)
        return json({ vm: vm.name, user, alias, ...(vm.publicIp ? { use: `ssh -F "$${SSH_CONFIG_VAR}" ${alias} 'uname -a'` } : { note: `The key is installed, but ${vm.name} has no public IP: reach it through Azure Bastion or a jump host, or use az vm run-command invoke.` }) })
      },
    },
    {
      name: "azure_request_secret",
      description: () => "Ask the user to enter the client secret of a service-principal account. They enter it outside the chat; you only learn whether it is set.",
      input: { type: "object", properties: { account: ACCOUNT, purpose: { type: "string", maxLength: 300 } }, additionalProperties: false },
      execute: async (input: { account?: string; purpose?: string }) => {
        const account = await service.pick(input.account)
        if (account.auth !== "serviceprincipal") throw new Error(`${account.id} signs in as a user: call azure_signin`)
        return json({
          status: (await service.vault.has(account.id, SP_SECRET)) ? "set (the user may replace it)" : "unset",
          tellUser: `Please enter the client secret for app ${account.clientId} in OpenCode's Azure view (Settings → Azure → ${account.id}), or in a terminal in the oc-azure folder: pixi run secret-set ${account.id}${input.purpose ? ` — for: ${input.purpose}` : ""}`,
        })
      },
    },
  ]
}
