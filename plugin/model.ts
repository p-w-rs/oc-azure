import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-azure-accounts/1"

/**
 * How an account signs in (always through the Azure CLI):
 * - browser: Microsoft sign-in in a browser on the OpenCode computer (works with SSO, MFA, Conditional Access).
 * - device: a code entered at microsoft.com/devicelogin on any device (for remote OpenCode servers).
 * - serviceprincipal: an app registration with a client secret the user enters.
 */
export type Auth = "browser" | "device" | "serviceprincipal"

/** One Microsoft identity in one tenant (Entra ID directory). Its subscriptions come with the sign-in. */
export interface Account {
  readonly id: string
  readonly label?: string
  readonly auth: Auth
  /** Tenant: domain (contoso.com) or directory id. Optional for browser/device (home tenant). */
  readonly tenant?: string
  /** App (client) id, for serviceprincipal. */
  readonly clientId?: string
  /** Subscription (name or id) commands use unless they pass --subscription. */
  readonly subscription?: string
  readonly notes?: string
  readonly updatedAt: string
}

export interface VmSummary {
  readonly name: string
  readonly resourceGroup: string
  readonly subscription: string
  readonly size: string
  readonly location: string
  readonly os: "linux" | "windows"
  readonly publicIp?: string
  readonly privateIp?: string
  readonly adminUser?: string
  readonly id: string
  /** Estimated pay-as-you-go $/hr from Azure's public price list. */
  readonly costPerHr?: number
}

/** What the plugin learned about an account. Rediscovered; never exported. */
export interface Discovery {
  readonly user?: string
  readonly name?: string
  readonly tenantId?: string
  readonly subscriptions?: readonly { readonly id: string; readonly name: string; readonly isDefault: boolean; readonly state: string }[]
  readonly running?: readonly VmSummary[]
  readonly stoppedVms?: number
  readonly checkedAt?: string
  readonly error?: string
}

export const AREAS = ["resources", "identity", "devops", "ai", "other"] as const
export type Area = (typeof AREAS)[number]
/** spend: creates or starts something billable. */
export const VERBS = ["read", "write", "spend", "delete", "admin"] as const
export type Verb = (typeof VERBS)[number]
export const CAPABILITIES = [
  ...AREAS.flatMap(area => VERBS.map(verb => `${area}-${verb}` as const)),
  "ssh", "manage", "remove",
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. Costs, deletes, admin and unknown writes ask. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return /-(spend|delete|admin)$/.test(capability) || ["other-write", "remove"].includes(capability) ? "ask" : "allow"
}

/** Vault secret names (entity = account id). */
export const TOKEN_CACHE = "az-token-cache"
export const SP_SECRET = "client-secret"
export const SSH_KEY = "ssh-key"
export const SECRET_NAMES = [TOKEN_CACHE, SP_SECRET, SSH_KEY] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return (value as string).trim()
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "auth", "tenant", "clientId", "subscription", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const auth = (raw.auth ?? "browser") as Auth
  if (!["browser", "device", "serviceprincipal"].includes(auth)) fail("auth must be browser, device or serviceprincipal")
  const tenant = text(raw.tenant, "tenant", 200)
  if (tenant !== undefined && !GUID.test(tenant) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(tenant)) fail("tenant must be a domain (contoso.com) or a directory id (GUID)")
  const clientId = text(raw.clientId, "clientId", 64)
  if (clientId !== undefined && !GUID.test(clientId)) fail("clientId must be the app (client) id, a GUID")
  if (auth === "serviceprincipal" && (!clientId || !tenant)) fail("serviceprincipal accounts need clientId and tenant")
  const subscription = text(raw.subscription, "subscription", 200)
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return { id, auth, ...(label && { label }), ...(tenant && { tenant }), ...(clientId && { clientId }), ...(subscription && { subscription }), ...(notes && { notes }), updatedAt: now.toISOString() }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

/** SSH host alias for a VM, e.g. "az-work-neo4j-vm". */
export function vmAlias(account: string, vm: { name: string }): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `az-${slug(account)}-${slug(vm.name).slice(0, 50)}`
}

// ------------------------------------------------------------------ what an az command does

/** One `az …` invocation found in a shell command. */
export interface AzCall {
  /** Command group and verb words, e.g. ["vm", "create"]. */
  readonly words: readonly string[]
  /** Flags and their values (last wins), e.g. { "--method": "post" }. */
  readonly flags: Readonly<Record<string, string | true>>
}

/** Splits a shell command into simple words; quotes are honored, substitutions and operators split commands. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]]
  let word = "", quote: "'" | '"' | undefined, inWord = false
  const push = () => { if (inWord) segments.at(-1)!.push(word); word = ""; inWord = false }
  const split = () => { push(); if (segments.at(-1)!.length) segments.push([]) }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; inWord = true; continue }
    if (/\s/.test(c)) { if (c === "\n") split(); else push(); continue }
    if (";&|()`".includes(c) || (c === "$" && command[i + 1] === "(")) { split(); if (c === "$") i++; continue }
    word += c; inWord = true
  }
  push()
  return segments.filter(segment => segment.length)
}

/** The `az` invocations in a shell command, and an explicit account choice (AZ_ACCOUNT=<id>). */
export function findAzCalls(command: string): { calls: AzCall[]; account?: string } {
  const calls: AzCall[] = []
  let account: string | undefined
  for (const segment of shellSegments(command)) {
    let i = 0
    for (; i < segment.length; i++) {
      const word = segment[i]!
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word)
      if (assignment) { if (assignment[1] === "AZ_ACCOUNT") account = assignment[2]; continue }
      if (["sudo", "time", "nohup", "env", "command", "exec", "xargs", "watch"].includes(word) || word.startsWith("-")) continue
      break
    }
    const head = segment[i]
    if (head !== "az" && !head?.endsWith("/az")) continue
    const rest = segment.slice(i + 1)
    const words: string[] = []
    const flags: Record<string, string | true> = {}
    let j = 0
    for (; j < rest.length && !rest[j]!.startsWith("-"); j++) words.push(rest[j]!.toLowerCase())
    for (; j < rest.length; j++) {
      const token = rest[j]!
      if (!token.startsWith("-")) continue
      const eq = token.indexOf("=")
      if (eq > 0) { flags[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1); continue }
      const next = rest[j + 1]
      if (next !== undefined && !next.startsWith("-")) { flags[token.toLowerCase()] = next; j++ } else flags[token.toLowerCase()] = true
    }
    calls.push({ words, flags })
  }
  return { calls, ...(account !== undefined && { account }) }
}

const BILLABLE = new Set([
  "vm", "vmss", "aks", "webapp", "functionapp", "appservice", "staticwebapp", "sql", "postgres", "mysql", "cosmosdb", "redis",
  "cognitiveservices", "ml", "batch", "container", "containerapp", "acr", "disk", "snapshot", "image", "sig", "deployment",
  "group", "hdinsight", "databricks", "synapse", "spring", "search", "signalr", "eventhubs", "servicebus", "apim", "iot",
  "bastion", "kusto", "dms", "netappfiles", "vmware", "devcenter", "network", "storage", "monitor", "datafactory",
])
const BILLABLE_NETWORK = /^(public-ip|vnet-gateway|application-gateway|bastion|firewall|nat|lb|express-route|vpn-gateway|front-door|private-endpoint|dns)$/
const SPEND_VERBS = new Set(["create", "start", "deploy", "resize", "scale", "up", "restore", "redeploy", "reimage", "add-node", "install", "upgrade"])
const READ_VERB = /^(list|show|get|query|exists|wait|check|browse|download|export|tail|logs|log|find|version|usage|preview|validate|what-if|describe|search|view|status)(-|$)|^(list|show|get)/
const ADMIN_WORDS = /^(lock|policy|role|identity|access-policy|set-policy|delete-policy|user|reset-ssh|admin|permission|rbac|member|owner)$/

/** Permission an `az` invocation needs. */
export function classifyAz(call: AzCall): Capability {
  const [group = "", ...more] = call.words
  if (group === "rest") return classifyRestCall(String(call.flags["--method"] ?? call.flags["-m"] ?? "get"), String(call.flags["--url"] ?? call.flags["--uri"] ?? call.flags["-u"] ?? ""), call.flags["--resource"] as string | undefined)
  const verb = call.words.at(-1) ?? ""
  const area: Area =
    ["ad", "role", "identity"].includes(group) ? "identity"
      : ["devops", "repos", "pipelines", "boards", "artifacts"].includes(group) ? "devops"
        : ["cognitiveservices", "ml"].includes(group) ? "ai"
          : ["account", "login", "logout", "version", "config", "extension", "upgrade", "find", "feedback", "interactive", "bicep", "cache", "init", "self-test", "survey", ""].includes(group) ? "other"
            : "resources"
  if (group === "" || ["version", "find", "feedback"].includes(group)) return "other-read"
  if (group === "account" || group === "config" || group === "cache" || group === "bicep") return READ_VERB.test(verb) || ["set", "clear"].includes(verb) && group === "account" ? "other-read" : "other-write"
  if (["login", "logout", "extension", "upgrade"].includes(group)) return READ_VERB.test(verb) && group === "extension" ? "other-read" : "other-write"
  if (READ_VERB.test(verb) || call.words.some(word => /^(list|show)-/.test(word))) return `${area}-read`
  if (area === "identity") return /^(delete|remove)/.test(verb) ? "identity-delete" : "identity-admin"
  if (call.words.some(word => ADMIN_WORDS.test(word)) && !(group === "vm" && verb === "create")) return `${area}-admin`
  if (/^(delete|purge|remove|destroy)/.test(verb)) return `${area}-delete`
  const billable = BILLABLE.has(group) && (group !== "network" || BILLABLE_NETWORK.test(more[0] ?? "")) && (group !== "storage" || more[0] === "account")
  if (SPEND_VERBS.has(verb) && (billable || group === "deployment")) return `${area}-spend`
  if (group === "deployment" || (group === "group" && more[0] === "deployment")) return `${area}-spend`
  return `${area}-write`
}

/** Permission an HTTP call made with `az rest` needs, from its method and URL. */
export function classifyRestCall(method: string, url: string, resource?: string): Capability {
  const m = method.toUpperCase()
  let host = "", path = url
  try { const parsed = new URL(url.startsWith("http") ? url : `https://management.azure.com${url.startsWith("/") ? "" : "/"}${url}`); host = parsed.hostname; path = parsed.pathname } catch {}
  const area: Area = /graph\.microsoft\.com$/.test(host) ? "identity"
    : /dev\.azure\.com$|visualstudio\.com$/.test(host) || resource === "499b84ac-1321-427f-aa17-267ca6975798" ? "devops"
      : /cognitiveservices|openai\.azure\.com|services\.ai\.azure\.com/.test(host) ? "ai"
        : "resources"
  if (m === "GET" || m === "HEAD") return `${area}-read`
  if (m === "DELETE") return `${area}-delete`
  if (area === "identity") {
    const directory = /^\/(v1\.0|beta)\/(users|groups|applications|servicePrincipals|roleManagement|directoryRoles|directory|oauth2PermissionGrants|policies|identity|domains|organization|invitations)(\/|$)/i
    return directory.test(path) ? "identity-admin" : "identity-write"
  }
  if (area === "resources") {
    if (m === "POST" && /\/(query|listKeys|listKeysWithSecrets|listCredentials|list[A-Z]\w*|validate|whatIf|checkNameAvailability)$/i.test(path)) return "resources-read"
    if (/\/providers\/Microsoft\.Authorization\//i.test(path)) return "resources-admin"
    if (m === "POST" && /\/(start|restart|redeploy|reimage)$/i.test(path)) return "resources-spend"
    if (m === "PUT" && !/\/tags\//i.test(path)) return "resources-spend"
  }
  if (area === "ai" && m === "POST") return "ai-write"
  return `${area}-write`
}
