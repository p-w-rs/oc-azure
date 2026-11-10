# oc-azure

Azure for OpenCode agents through the **Azure CLI in the agent's own shell**:
resources and subscriptions, VMs (including SSH and rsync into Linux VMs),
costs, Entra ID and Microsoft Graph, Azure DevOps and Azure AI. The plugin keeps
a separate Microsoft sign-in per account, supplies it only to the commands that
run `az`, and checks **what each command does** against a permission table:
reads run, ordinary changes run, and creating or starting billable resources,
deleting and role/directory changes ask. macOS and Linux; OpenCode 2.2.6+ and
Pixi.

## How it works

- The plugin installs its own pinned Azure CLI (Python, via Pixi, about 300 MB,
  once) and puts it first on `PATH` for commands that use `az`.
- Each such command gets a private, temporary CLI profile with that account's
  token cache. Refreshed tokens are saved back encrypted; nothing is left in
  `~/.azure`, and tokens the CLI prints are masked.
- Before the command runs, every `az …` in it is classified (e.g.
  `az vm create` → resources-spend, `az group delete` → resources-delete,
  `az rest --method post --url https://graph.microsoft.com/v1.0/groups` →
  identity-admin). If one is not allowed, the command still runs but signed
  out, and the agent is told why.
- Several accounts: `AZ_ACCOUNT=<id> az …`.

## Accounts and sign-in

One account = one Microsoft identity in one tenant; its subscriptions come with
the sign-in.

| `auth` | How |
|---|---|
| `browser` (default) | Microsoft sign-in in a browser on the OpenCode computer: SSO, MFA, Conditional Access |
| `device` | A code at microsoft.com/devicelogin on any device (remote servers) |
| `serviceprincipal` | App id + tenant; the client secret is entered in the GUI or with `pixi run secret-set` |

## What agents get

| Tool | |
|---|---|
| `azure_list` | Accounts, subscriptions, running VMs with estimated $/hr (Azure list prices) and SSH aliases; also in the tool description, so agents remember to deallocate what they started |
| `azure_ssh_setup` | Adds the plugin's SSH key to a running Linux VM (`az vm user update`; no restart) |
| `azure_account_upsert` / `_remove`, `azure_signin`, `azure_refresh`, `azure_request_secret` | Setup |

Plus `az` itself, and for VMs with a public IP:

```sh
ssh -F "$AZURE_SSH_CONFIG" az-work-dev-box 'uname -a'
rsync -az -e "ssh -F '$AZURE_SSH_CONFIG'" ./src/ az-work-dev-box:~/src/
```

The `azure` skill covers subscriptions and queries, money (stop vs deallocate,
prices, tags, cost queries), VMs and SSH (and `az vm run-command` when there is
no public IP), Graph (mail, Teams, SharePoint), DevOps and Azure AI.

## Permissions

Per account, for resources, Entra ID & Microsoft 365, Azure DevOps, AI services
and CLI/other: read, change, **create/start (costs)**, delete, roles & admin;
plus SSH into VMs and edit/remove account. Defaults: reads, changes and SSH run;
costs, deletes, admin and unknown writes ask. Every cell is editable in the GUI
(`/azure`, the Review-pane **+** menu, or **Settings → Azure**); **Allow
always** on a prompt writes allow. Azure's own roles still apply.

## Setup

```sh
pixi run --locked install                          # verified snapshot into your OpenCode config
pixi run signin work --tenant contoso.com          # or the GUI, or ask your agent
pixi run signin work --device                      # code-based sign-in
```

## Development

```sh
pixi run --locked test            # fake az (profile/token-cache behavior) + a real local sshd
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake az
```
