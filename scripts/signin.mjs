// Microsoft sign-in for an Azure account from a terminal (the GUI and azure_signin do the same).
//   pixi run signin <account> [--tenant contoso.com] [--device]
// Creates the account if needed and installs the plugin's Azure CLI on first use. Never prints tokens.
import { pluginDataDir } from "oc-secure-kit"
import { mergeAccount, normalizeAccount } from "../plugin/model.ts"
import { AzureService } from "../plugin/service.ts"

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined }
const id = args[0] && !args[0].startsWith("--") ? args[0] : undefined
if (!id) { console.error("Usage: pixi run signin <account> [--tenant contoso.com] [--device]"); process.exit(2) }

const service = await AzureService.open(pluginDataDir("oc-azure", process.env.OC_AZURE_DATA_DIR || undefined))
await service.tools.ensure(line => console.log(line))
let account = await service.store.get(id)
if (!account || option("--tenant")) account = await service.store.put(normalizeAccount({ ...mergeAccount(account, {}), id, ...(option("--tenant") && { tenant: option("--tenant") }) }))
const state = await service.startSignIn(account, { ...(args.includes("--device") && { device: true }) })
console.log(state.code
  ? `\nOn any device, open ${state.url} and enter the code ${state.code}.\n`
  : `\nA Microsoft sign-in page opened in your browser${state.url ? ` (${state.url.split("?")[0]})` : ""}. Sign in${account.tenant ? ` to ${account.tenant}` : ""} and approve.\n`)
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(`Sign-in did not finish: ${state.error}`); process.exit(1) }
const d = await service.store.discovery(id)
console.log(`Signed in as ${d?.name ?? "?"} (${d?.user ?? "?"}). Subscriptions: ${d?.subscriptions?.map(sub => sub.name).join(", ") || "none"}. Running VMs: ${d?.running?.length ?? 0}.`)
if (d?.error) console.log(`Problem: ${d.error}`)
service.dispose()
process.exit(d?.error ? 1 : 0)
