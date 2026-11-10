import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, ShellSupplier, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect } from "./model.js"
import { AzureRpc } from "./rpc.js"
import { AzureService, PLUGIN_ID } from "./service.js"
import { prepareCommand, sshTip } from "./supply.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface AzureOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-azure`. */
  readonly dataDirectory?: string
  /** Use this az instead of the plugin's own Azure CLI (tests). */
  readonly azPath?: string
  /** Azure Retail Prices API URL (tests). */
  readonly pricesUrl?: string
}

export function parseOptions(raw: unknown): AzureOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  for (const key of ["dataDirectory", "azPath", "pricesUrl"]) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${PLUGIN_ID}: ${key} must be a string`)
  if (options.pricesUrl !== undefined && !/^https?:\/\//.test(options.pricesUrl as string)) throw new Error(`${PLUGIN_ID}: pricesUrl must be an http(s) URL`)
  return Object.fromEntries(["dataDirectory", "azPath", "pricesUrl"].filter(key => options[key] !== undefined).map(key => [key, options[key]])) as AzureOptions
}

const SKILL = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url))
const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const service = await AzureService.open(pluginDataDir(PLUGIN_ID, options.dataDirectory), {
          ...(options.azPath && { azPath: options.azPath }), ...(options.pricesUrl && { pricesUrl: options.pricesUrl }),
        })
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)

        const tools = createTools(service)
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        // The agent's own az (and ssh to VMs): only commands that use az or $AZURE_SSH_CONFIG are touched.
        const shell = new ShellSupplier({ plugin: PLUGIN_ID, redactor: service.redactor, warn, prepare: (command, caller) => prepareCommand(service, command, caller), annotate: sshTip })
        registrations.push({ dispose: () => shell.dispose() })
        registrations.push(await ctx.tool.hook("execute.before", event => shell.before(event)))
        registrations.push(await ctx.shell.hook("create.before", event => shell.create(event)))
        registrations.push(await ctx.tool.hook("execute.after", async event => { await shell.after(event as never); await service.syncRedactor().catch(() => {}) }))

        try {
          const content = await readFile(SKILL, "utf8")
          const description = /^description:\s*(.+)$/m.exec(content)?.[1] ?? "Azure know-how"
          registrations.push(await ctx.skill.transform(editor => {
            editor.add({ id: "azure" as never, name: "azure" as never, description, path: SKILL as never, content })
          }))
        } catch (error) { warn("skill not registered", error) }

        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve().then(() => ctx.tool.reload()).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })

        // Install the CLI in the background if needed, and keep the running-VM reminder current.
        if (!(await service.tools.ready())) void service.tools.ensure().catch(error => warn("Azure CLI not installed", error))
        const timer = setInterval(() => {
          void service.store.list().then(accounts => Promise.all(accounts.map(async account => { if (await service.signedIn(account)) await service.rediscover(account) }))).catch(() => {})
        }, 15 * 60_000)
        timer.unref?.()
        registrations.push({ dispose: () => clearInterval(timer) })

        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(AzureRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(AzureRpc, handlers as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
