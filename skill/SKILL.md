---
name: azure
description: Work effectively in Azure through the oc-azure plugin and the Azure CLI — subscriptions and resource groups, VMs (create, start, deallocate, SSH and rsync), storage, networking, AKS, App Service, costs, Entra ID and Microsoft Graph (users, groups, apps, mail, Teams), Azure DevOps (repos, pipelines, boards) and Azure AI / OpenAI deployments. Load before non-trivial Azure work.
---

# Working in Azure

## How it works

- Use `az` in your own shell (the plugin's pinned Azure CLI is put first on `PATH`). The plugin signs each command
  that runs `az` in with the right account (a private, temporary CLI profile; tokens never reach you) and checks every
  `az …` in it against the user's permission table. If one is not allowed the command still runs, but **signed out** —
  read the `[oc-azure]` note and tell the user. `Please run 'az login'` means the same; never run `az login` yourself:
  use `azure_signin` (`device=true` if no browser opens).
- Defaults: reads, ordinary changes and SSH run; creating/starting billable things, deletes, role/directory changes,
  `az login`/`az extension add` and other CLI writes ask.
- Several accounts: prefix `AZ_ACCOUNT=<id> az …`. `azure_list` shows accounts, subscriptions, running VMs, $/hr and
  what you may do. `AZ_ACCOUNT=none` bypasses the plugin (only when the user asks).
- Subscriptions: pass `--subscription <name|id>` per command, or rely on the account's default (shown in
  `azure_list`). `az account set` persists for that account's later commands; prefer `--subscription`.
- Each command gets a fresh profile: only the login, subscription choice and `az config` survive. **Extensions** do
  not — install and use them from a stable folder: `AZURE_EXTENSION_DIR="$HOME/.azure/cliextensions" az extension add -n <name>`
  and the same prefix on every command that uses it. Commands needing an extension (e.g. `az costmanagement`) otherwise
  try to install it each time.
- Output: `-o json` for parsing, `-o table` for humans; `--query` (JMESPath) to cut output down, e.g.
  `az vm list -d --query "[?powerState=='VM running'].{name:name, rg:resourceGroup, size:hardwareProfile.vmSize}" -o table`.
- Everything az cannot do directly: `az rest --method get --url <https://…>` (ARM, Graph, DevOps, data planes); az
  adds the right token (`--resource` for other audiences). Classified by method and URL like other commands.
- Never print tokens (`az account get-access-token` output is masked anyway); never write credentials to files.

## Money first

- VMs bill per second while running (compute) and always for disks and public IPs. **Stopped ≠ deallocated**:
  `az vm stop` keeps billing compute; use `az vm deallocate -g <rg> -n <vm>`.
- Before creating or starting anything billable, state the size, region and estimated $/hr (`azure_list` shows list
  prices for running VMs; for a new size: `az vm list-sizes -l <region>`, `az vm list-skus -l <region> --size <s>` for
  availability, and the Retail Prices API:
  `curl "https://prices.azure.com/api/retail/prices?\$filter=armSkuName eq 'Standard_D4s_v5' and armRegionName eq 'westus2' and priceType eq 'Consumption'"`).
- **Many VMs belong to colleagues and production.** Only stop, deallocate, resize or delete resources you created in
  this conversation or the user names. Look before you change: `az vm show`, tags, the resource group's purpose.
- Tag what you create (`--tags createdBy=opencode purpose=<…>`) and put it in its own resource group so cleanup is
  `az group delete -n <rg>` (asks). Deallocate VMs you started when the work is done.
- Costs: `az consumption usage list` (preview) or `az rest --method post --url "https://management.azure.com/subscriptions/<id>/providers/Microsoft.CostManagement/query?api-version=2023-11-01" --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"total":{"name":"Cost","function":"Sum"}},"grouping":[{"type":"Dimension","name":"ResourceGroupName"}]}}'`
  (needs Cost Management Reader; a 401/403 means the user lacks that role — say so).

## VMs and SSH

```sh
az group create -n rg-me-scratch -l westus2 --tags createdBy=opencode
az vm create -g rg-me-scratch -n scratch1 --image Ubuntu2404 --size Standard_B2s --admin-username azureuser \
  --generate-ssh-keys --public-ip-sku Standard --tags createdBy=opencode
```

- You cannot read the plugin's key, so do not pass it to `--ssh-key-values`. Once the Linux VM is running, call
  `azure_ssh_setup vm=<name>` (adds the plugin's key via `az vm user update`, keeps other keys, no restart; asks), then:
  `ssh -F "$AZURE_SSH_CONFIG" az-<account>-<vm> 'uname -a'` and `rsync -az -e "ssh -F '$AZURE_SSH_CONFIG'" ./src/ az-<account>-<vm>:~/src/`.
- `$AZURE_SSH_CONFIG` only contains the aliases written literally in that command (exact names from `azure_list`),
  for **running Linux VMs with a public IP**. Start a VM first (`az vm start`, asks); a new IP means a new lookup.
- No public IP (most corporate VMs) or Windows: `az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts "…"`
  (Windows: `RunPowerShellScript`), or Azure Bastion (`az network bastion ssh`, needs the `bastion` extension).
- Open ports with NSG rules only when asked, and as narrowly as possible (`--source-address-prefixes <your ip>/32`).
- Long jobs: `nohup …&` or `tmux`, log to a file, check back later (set a reminder).

## Entra ID and Microsoft Graph

- `az ad user|group|app|sp …` for directory objects (`az ad signed-in-user show` for me); `az role assignment list
  --assignee <id> --all` for Azure roles. `az rest --url "https://graph.microsoft.com/v1.0/…"` for other Graph reads.
- Directory changes (users, groups, apps, role assignments, consent) ask by default and affect the whole company:
  confirm the exact change first.
- The Azure CLI's Graph token has directory scopes, not mail/calendar/Teams/files ones: `/me/messages`, Teams and
  similar usually return 403. Use the Microsoft 365 plugin (`m365_graph`) for those if it is installed; otherwise tell
  the user which permission is missing rather than trying another way.

## Azure DevOps

- `az devops` / `az repos` / `az pipelines` / `az boards` come from the `azure-devops` extension (see extensions
  above). Its `az devops configure -d …` defaults do not persist here, so pass `--org https://dev.azure.com/<org>`
  and `--project <p>` on each command: `az repos pr list`, `az pipelines runs list`,
  `az boards query --wiql "SELECT [System.Id],[System.Title] FROM workitems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed'"`.
- Or without the extension: `az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "https://dev.azure.com/<org>/_apis/projects?api-version=7.1"`.
- "No profile for the authenticated user" means the user has never used Azure DevOps with this identity: ask for the
  organization URL.

## Azure AI / OpenAI

- `az cognitiveservices account list`, `… account deployment list -g <rg> -n <account>`, available models
  `… account list-models -g <rg> -n <account>`, quota `… usage list -l <region>`. Creating accounts or deployments
  costs money (asks). Call models with the data-plane endpoint and a token:
  `az rest --resource https://cognitiveservices.azure.com --method post --url "<endpoint>/openai/deployments/<d>/chat/completions?api-version=2024-10-21" --body @req.json`
  (needs a data-plane role such as Cognitive Services OpenAI User).

## Errors

`AuthorizationFailed` = the identity lacks a role on that scope (report the exact scope); `AADSTS…` = sign-in
problem (`azure_signin` again; read the code); `SkuNotAvailable`/quota errors = another region or size;
`Please run 'az login'` = the command ran signed out (not signed in or not allowed — see the note).
