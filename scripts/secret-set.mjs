// Enter the client secret of a service-principal account. Read with echo off, or from stdin.
//   pixi run secret-set <account>
import { createInterface } from "node:readline"
import { pluginDataDir } from "oc-secure-kit"
import { SP_SECRET } from "../plugin/model.ts"
import { AzureService } from "../plugin/service.ts"

const [id] = process.argv.slice(2)
if (!id) { console.error("Usage: pixi run secret-set <account>"); process.exit(2) }
const service = await AzureService.open(pluginDataDir("oc-azure", process.env.OC_AZURE_DATA_DIR || undefined))
const account = await service.store.get(id)
if (!account) { console.error(`No account ${id}.`); process.exit(1) }
if (account.auth !== "serviceprincipal") { console.error(`${id} signs in as a user: pixi run signin ${id}`); process.exit(1) }
function readHidden(prompt) {
  if (!process.stdin.isTTY) return new Promise(resolve => { let data = ""; process.stdin.on("data", c => { data += c }); process.stdin.on("end", () => resolve(data.trim())) })
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = text => { if (!muted) process.stdout.write(text) }
    rl.question(prompt, answer => { rl.close(); process.stdout.write("\n"); resolve(answer.trim()) })
    muted = true
  })
}
const secret = await readHidden(`Client secret for ${id} (app ${account.clientId}): `)
if (!secret) { console.error("Empty; nothing stored."); process.exit(1) }
await service.vault.set(id, SP_SECRET, secret)
console.log(`Stored. Sign in with: pixi run signin ${id}`)
service.dispose()
