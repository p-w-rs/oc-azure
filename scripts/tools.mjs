// Installs (or updates) the plugin's pinned Azure CLI into the data directory. Also runs on first use.
import { pluginDataDir } from "oc-secure-kit"
import { AzureService } from "../plugin/service.ts"
const service = await AzureService.open(pluginDataDir("oc-azure", process.env.OC_AZURE_DATA_DIR || undefined))
console.log(`az: ${await service.tools.ensure(line => console.log(line))}`)
service.dispose()
