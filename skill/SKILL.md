---
name: azure
description: Work effectively in Azure through the oc-azure plugin and the Azure CLI — subscriptions and resource groups, VMs (create, start, deallocate, SSH and rsync), storage, networking, AKS, App Service, costs, Entra ID and Microsoft Graph (users, groups, apps, mail, Teams), Azure DevOps (repos, pipelines, boards) and Azure AI / OpenAI deployments. Load before non-trivial Azure work.
---

# Working in Azure

## How it works

- Use `az` in your own shell. The plugin signs each `az` command in with the right account (a private, per-command
  CLI profile; tokens never reach you) and checks what the command does against the user's permission table. If a
  command is not allowed it still runs, but **signed out** — read the `[oc-azure]` note and tell the user.
- Several accounts: prefix `AZ_ACCOUNT=<id> az …`. `azure_list` shows accounts, subscriptions, running VMs and costs.
- Subscriptions: pass `--subscription <name|id>` per command, or rely on the account's default (shown in
  `azure_list`). `az account set` only lasts for that account's later commands; prefer `--subscription`.
- Output: `-o json` for parsing, `-o table` for humans; `--query` (JMESPath) to cut output down, e.g.
  `az vm list -d --query "[?powerState=='VM running'].{name:name, rg:resourceGroup, size:hardwareProfile.vmSize}" -o table`.
- Everything az cannot do directly: `az rest --method get --url <https://…>` (ARM, Graph, DevOps, data planes); az
  adds the right token. Classified by method and URL like other commands.
- Never print tokens (`az account get-access-token` output is masked anyway); never write credentials to files.

## Money first

- VMs bill per second while running (compute) and always for disks and public IPs. **Stopped ≠ deallocated**:
  `az vm stop` keeps billing compute; use `az vm deallocate`.
- Before creating or starting anything billable, state the size, region and estimated $/hr (the inventory shows
  list prices for running VMs; for a new size: `az vm list-sizes -l <region>` and the
  [pricing calculator](https://azure.microsoft.com/pricing/calculator/), or the Retail Prices API:
  `curl "https://prices.azure.com/api/retail/prices?\$filter=armSkuName eq 'Standard_D4s_v5' and armRegionName eq 'westus2' and priceType eq 'Consumption'"`).
- **Many VMs belong to colleagues and production.** Only stop, deallocate, resize or delete resources you created in
  this conversation or the user names. Look before you change: `az vm show`, tags, the resource group's purpose.
- Prefer tagging what you create: `--tags createdBy=opencode purpose=<…>`, and put it in its own resource group so
  cleanup is `az group delete -n <rg>` (asks the user).
- Costs: `az consumption usage list` or `az rest --method post --url "https://management.azure.com/subscriptions/<id>/providers/Microsoft.CostManagement/query?api-version=2023-11-01" --body '{"type":"ActualCost","timeframe":"MonthToDate","dataset":{"granularity":"None","aggregation":{"total":{"name":"Cost","function":"Sum"}},"grouping":[{"type":"Dimension","name":"ResourceGroupName"}]}}'`
  (needs Cost Management Reader; a 401/403 means the user lacks that role — say so).

## VMs and SSH

```sh
az vm create -g rg-me-scratch -n scratch1 --image Ubuntu2404 --size Standard_B2s --admin-username azureuser \
  --ssh-key-values "$(cat <plugin public key>)" --public-ip-sku Standard --tags createdBy=opencode
```

- For SSH, call `azure_ssh_setup vm=<name>` (adds the plugin's key to a running Linux VM, no restart), then:
  `ssh -F "$AZURE_SSH_CONFIG" az-<account>-<vm> 'uname -a'` and `rsync -az -e "ssh -F '$AZURE_SSH_CONFIG'" ./src/ az-<account>-<vm>:~/src/`.
- No public IP (most corporate VMs): use `az vm run-command invoke -g <rg> -n <vm> --command-id RunShellScript --scripts "…"`
  (Windows: `RunPowerShellScript`), or Azure Bastion (`az network bastion ssh`, needs the bastion extension).
- Open ports with NSG rules only when asked, and as narrowly as possible (`--source-address-prefixes <your ip>/32`).
- Long jobs: `nohup …&` or `tmux`, log to a file, poll.

## Entra ID and Microsoft Graph

- `az ad user|group|app|sp …` for directory objects; `az rest` for everything else in Graph, e.g.
  `az rest --url "https://graph.microsoft.com/v1.0/me/messages?\$top=5&\$select=subject,from,receivedDateTime"`,
  `az rest --url "https://graph.microsoft.com/v1.0/me/joinedTeams"`, `…/sites?search=<name>` (SharePoint).
- Directory changes (users, groups, apps, role assignments, consent) ask by default and affect the whole company:
  confirm the exact change first. Sending mail or posting in Teams acts as the user: draft and confirm first.
- Graph scopes come from the Azure CLI's sign-in; some APIs (e.g. Mail.Send) may be refused with 403 — then tell the
  user what permission is missing rather than trying another way.

## Azure DevOps

- `az devops` (extension `azure-devops`, installed on first use: `az extension add -n azure-devops`, which asks):
  `az devops configure -d organization=https://dev.azure.com/<org> project=<project>`, then `az repos pr list`,
  `az pipelines runs list`, `az boards query --wiql "SELECT [System.Id],[System.Title] FROM workitems WHERE [System.AssignedTo] = @Me AND [System.State] <> 'Closed'"`.
- Or `az rest --resource 499b84ac-1321-427f-aa17-267ca6975798 --url "https://dev.azure.com/<org>/_apis/projects?api-version=7.1"`.
- "No profile for the authenticated user" means the user has never used Azure DevOps with this identity: ask for the
  organization URL.

## Azure AI / OpenAI

- `az cognitiveservices account list`, `… account deployment list -g <rg> -n <account>`, model catalogs with
  `az cognitiveservices account list-models`. Creating deployments costs money (asks). Call models with the data-plane
  endpoint and a token: `az rest --resource https://cognitiveservices.azure.com --method post --url "<endpoint>/openai/deployments/<d>/chat/completions?api-version=2024-10-21" --body @req.json`.

## Errors

`AuthorizationFailed` = the identity lacks a role on that scope (report the exact scope); `AADSTS…` = sign-in
problem (sign in again; read the code); `SkuNotAvailable`/quota errors = another region or size;
`Please run 'az login'` = the command ran signed out (not signed in or not allowed — see the note).
