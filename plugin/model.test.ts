import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAz, classifyRestCall, defaultEffect, findAzCalls, normalizeAccount, shellSegments, vmAlias } from "./model.js"

test("accounts: defaults and validation", () => {
  assert.deepEqual(normalizeAccount({ id: "work", tenant: "contoso.com" }, new Date(0)), { id: "work", auth: "browser", tenant: "contoso.com", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.throws(() => normalizeAccount({ id: "sp", auth: "serviceprincipal", tenant: "x.com" }), /clientId/)
  assert.throws(() => normalizeAccount({ id: "w", tenant: "not a tenant" }), /tenant/)
  assert.throws(() => normalizeAccount({ id: "w", secret: "x" }), /Unknown account field/)
  assert.equal(vmAlias("work", { name: "Neo4j_VM" }), "az-work-neo4j-vm")
})

test("finding az calls in shell commands", () => {
  assert.deepEqual(shellSegments(`az vm list -o table && echo "a b" | grep x; $(az account show)`), [["az", "vm", "list", "-o", "table"], ["echo", "a b"], ["grep", "x"], ["az", "account", "show"]])
  const found = findAzCalls(`AZ_ACCOUNT=work az vm create -g rg -n x --image Ubuntu2204 --size=Standard_B2s; az rest -m post --url "https://graph.microsoft.com/v1.0/me/sendMail"`)
  assert.equal(found.account, "work")
  assert.deepEqual(found.calls[0], { words: ["vm", "create"], flags: { "-g": "rg", "-n": "x", "--image": "Ubuntu2204", "--size": "Standard_B2s" } })
  assert.deepEqual(found.calls[1]!.words, ["rest"])
  assert.deepEqual(findAzCalls("echo azure; azcopy copy a b; terraform plan").calls, [])
  assert.equal(findAzCalls("/usr/local/bin/az group list").calls.length, 1)
})

test("az commands are classified by what they do", () => {
  const kind = (command: string) => classifyAz(findAzCalls(command).calls[0]!)
  const cases: [string, string][] = [
    ["az vm list -d", "resources-read"], ["az vm show -g rg -n x", "resources-read"], ["az group list", "resources-read"],
    ["az storage blob download -c c -n n -f f", "resources-read"], ["az monitor metrics list --resource x", "resources-read"],
    ["az vm create -g rg -n x --image Ubuntu2204", "resources-spend"], ["az vm start -g rg -n x", "resources-spend"],
    ["az aks create -g rg -n k", "resources-spend"], ["az deployment group create -g rg -f main.bicep", "resources-spend"],
    ["az storage account create -n s -g rg", "resources-spend"], ["az network public-ip create -g rg -n ip", "resources-spend"],
    ["az vm stop -g rg -n x", "resources-write"], ["az vm deallocate -g rg -n x", "resources-write"], ["az storage blob upload -f a -c c", "resources-write"],
    ["az network nsg rule create -g rg --nsg-name n -n r", "resources-write"], ["az storage container create -n c", "resources-write"], ["az tag create --name x", "resources-write"],
    ["az vm delete -g rg -n x --yes", "resources-delete"], ["az group delete -n rg", "resources-delete"],
    ["az vm user update -g rg -n x -u me --ssh-key-value k", "resources-admin"], ["az lock create -n l -g rg", "resources-admin"], ["az keyvault set-policy -n kv", "resources-admin"],
    ["az ad user list", "identity-read"], ["az ad app create --display-name a", "identity-admin"], ["az role assignment create --role Reader", "identity-admin"],
    ["az ad group member remove -g g --member-id m", "identity-delete"],
    ["az cognitiveservices account list", "ai-read"], ["az cognitiveservices account deployment create -g rg -n a --deployment-name d", "ai-spend"],
    ["az devops project list", "devops-read"], ["az pipelines run --name p", "devops-write"], ["az boards work-item create --title t", "devops-write"],
    ["az account show", "other-read"], ["az account set -s dev", "other-read"], ["az account get-access-token", "other-read"], ["az version", "other-read"],
    ["az login", "other-write"], ["az extension add -n ssh", "other-write"], ["az extension list", "other-read"],
  ]
  for (const [command, expected] of cases) assert.equal(kind(command), expected, command)
})

test("az rest calls are classified by method and URL", () => {
  assert.equal(classifyRestCall("get", "https://graph.microsoft.com/v1.0/me"), "identity-read")
  assert.equal(classifyRestCall("post", "https://graph.microsoft.com/v1.0/me/sendMail"), "identity-write")
  assert.equal(classifyRestCall("patch", "https://graph.microsoft.com/v1.0/users/x"), "identity-admin")
  assert.equal(classifyRestCall("post", "/subscriptions/s/providers/Microsoft.CostManagement/query"), "resources-read")
  assert.equal(classifyRestCall("put", "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/x"), "resources-spend")
  assert.equal(classifyRestCall("put", "/subscriptions/s/providers/Microsoft.Authorization/roleAssignments/x"), "resources-admin")
  assert.equal(classifyRestCall("post", "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/x/start"), "resources-spend")
  assert.equal(classifyRestCall("post", "https://dev.azure.com/org/_apis/wit/workitems"), "devops-write")
  assert.equal(classifyRestCall("delete", "https://management.azure.com/x"), "resources-delete")
  assert.equal(classifyAz(findAzCalls(`az rest --method post --url https://graph.microsoft.com/v1.0/groups`).calls[0]!), "identity-admin")
})

test("defaults: reads, changes and SSH allowed; costs, deletes, admin, unknown writes ask", () => {
  for (const capability of ["resources-read", "resources-write", "identity-write", "ssh", "manage"]) assert.equal(defaultEffect(capability), "allow")
  for (const capability of ["resources-spend", "resources-delete", "identity-admin", "ai-spend", "other-write", "remove"]) assert.equal(defaultEffect(capability), "ask")
})
