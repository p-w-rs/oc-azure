import type { Rpc } from "@opencode/plugin/rpc"

const output = {} as const
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false }) as const
const sessionID = { type: "string", minLength: 1, maxLength: 200 }
const id = { type: "string", minLength: 1, maxLength: 64 }

export const AzureRpc = {
  id: "oc-azure.admin",
  methods: {
    state: { input: object({ sessionID }), output },
    setCells: {
      input: object({
        expectedRevision: { type: "integer", minimum: 0 }, sessionID,
        changes: { type: "array", maxItems: 200, items: object({ entity: { type: "string" }, capability: { type: "string" }, effect: { enum: ["allow", "ask", "deny", null] }, agent: { type: "string" }, session: { type: "boolean" } }, ["entity", "capability", "effect"]) },
      }, ["changes"]),
      output,
    },
    createAccount: { input: object({ id, auth: { enum: ["browser", "device", "serviceprincipal"] }, tenant: { type: "string" }, clientId: { type: "string" } }, ["id"]), output },
    updateAccount: { input: object({ id, tenant: { type: ["string", "null"] }, subscription: { type: ["string", "null"] } }, ["id"]), output },
    setSecret: { input: object({ id, secret: { type: "string", minLength: 1, maxLength: 4096 } }, ["id", "secret"]), output },
    installCli: { input: object({}), output },
    removeAccount: { input: object({ id }, ["id"]), output },
    signIn: { input: object({ id, device: { type: "boolean" } }, ["id"]), output },
    cancelSignIn: { input: object({ id }, ["id"]), output },
    refresh: { input: object({ id }, ["id"]), output },
    signOut: { input: object({ id }, ["id"]), output },
    setDefault: { input: object({ id: { type: ["string", "null"] } }, ["id"]), output },
    exportBundle: { input: object({ passphrase: { type: "string" } }, ["passphrase"]), output },
    previewImport: { input: object({ content: { type: "string", maxLength: 67108864 }, passphrase: { type: "string" } }, ["content", "passphrase"]), output },
    applyImport: { input: object({ content: { type: "string", maxLength: 67108864 }, passphrase: { type: "string" }, mode: { enum: ["merge", "replace"] } }, ["content", "passphrase", "mode"]), output },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition

export type Effect = "allow" | "ask" | "deny"

export interface AccountView {
  readonly id: string
  readonly label?: string
  readonly auth: string
  readonly tenant?: string
  readonly clientId?: string
  readonly subscription?: string
  readonly user?: string
  readonly name?: string
  readonly subscriptions?: readonly { id: string; name: string; isDefault: boolean }[]
  readonly running?: readonly { name: string; size: string; subscription: string; resourceGroup: string; costPerHr?: number }[]
  readonly error?: string
  readonly signedIn: boolean
  readonly secretSet: boolean
  readonly isDefault: boolean
  readonly signIn?: { readonly url?: string; readonly code?: string; readonly expiresAt: number; readonly status: string; readonly error?: string }
}

export interface StateView {
  readonly cli: "ready" | "missing" | "installing"
  readonly revision: number
  readonly fingerprint: string
  readonly accounts: readonly AccountView[]
  readonly agents: readonly { id: string; name: string; mode: string }[]
  readonly defaults: Record<string, Effect>
  readonly cells: Record<string, Record<string, Record<string, Effect>>>
  readonly session?: { readonly root: string; readonly cells: Record<string, Record<string, Effect>> }
}

export interface ImportPreview {
  readonly createdAt: string
  readonly accounts: readonly { id: string; status: string }[]
  readonly secrets: number
  readonly permissionEntities: number
}

export function inherited(state: Pick<StateView, "cells" | "defaults">, entity: string, capability: string, agent: string): Effect {
  if (agent !== "*") { const own = state.cells[entity]?.[agent]?.[capability]; if (own) return own }
  return state.cells[entity]?.["*"]?.[capability] ?? state.defaults[capability] ?? "ask"
}
