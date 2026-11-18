# Build the image with Cloud Build and deploy it as a Cloud Run INSTANCE.
# Usage (from C:\NLP_3\a3-agent):   .\deploy\deploy.ps1 -Tag v1
# Uses `gcloud beta run instances` only. Never `gcloud run deploy` (that creates a service).
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Project = "a3-sosapineda-599",
  [string]$Region = "us-west1",
  [string]$Instance = "a3-agent",
  [string]$Bucket = "a3-sosapineda-599-state",
  [string]$OllamaTailnetHost = "100.74.182.24",
  # 2 vCPU, measured on 2026-11-15: at 1 vCPU the gateway took 9m29s to become ready and
  # cron maintenance failed with SQLite admission timeouts; at 2 vCPU it is ready in about
  # 4m with no timeouts (PERFORMANCE_REPORT).
  [int]$Cpu = 2,
  # 4 GiB, measured on 2026-11-16: at 2 GiB the gateway idled at 1.62 GiB RSS and was
  # OOM-killed (exit 137) four times in 30 minutes when one request started two subagents.
  [string]$Memory = "4Gi",
  # Extra addresses the agent may email, comma-separated. The test account itself is always
  # allowed; anything else must be listed here or the send is refused.
  [string]$EmailAllowlist = "",
  # 1 = OpenClaw manages the Tailscale Serve route (tokenless grader access); 0 = token + pairing.
  [string]$ManagedServe = "1",
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"

$image = "$Region-docker.pkg.dev/$Project/a3/a3-agent:$Tag"
$runtimeSa = "a3-runtime@$Project.iam.gserviceaccount.com"

if (-not $SkipBuild) {
  Write-Host "Building $image ..."
  gcloud builds submit . --tag $image --project $Project
  if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed" }
}

$envVars = "A3_OLLAMA_TAILNET_HOST=$OllamaTailnetHost,TAILSCALE_HOSTNAME=a3-agent,A3_MANAGED_SERVE=$ManagedServe"
if ($EmailAllowlist -ne "") {
  # gcloud splits this flag on commas, so the addresses travel separated by ";".
  # The agent accepts commas, semicolons or spaces between addresses.
  $allow = ($EmailAllowlist -split '[,;\s]+' | Where-Object { $_ -ne "" }) -join ";"
  $envVars = "$envVars,A3_EMAIL_ALLOWLIST=$allow"
}

Write-Host "Deploying instance $Instance ..."
# --clear-volumes first: repeating --add-volume on a redeploy otherwise keeps old entries.
gcloud beta run instances deploy $Instance `
  --project $Project `
  --region $Region `
  --image $image `
  --service-account $runtimeSa `
  --cpu $Cpu `
  --memory $Memory `
  --port 18789 `
  --restart-policy always `
  --invoker-iam-check `
  --clear-volumes `
  --add-volume "name=state,type=cloud-storage,bucket=$Bucket,mount-options=uid=1000;gid=1000;file-mode=600;dir-mode=700" `
  --add-volume-mount "volume=state,mount-path=/mnt/agent-state" `
  --startup-probe "tcpSocket.port=18789,initialDelaySeconds=60,periodSeconds=20,timeoutSeconds=5,failureThreshold=30" `
  --set-env-vars $envVars `
  --set-secrets "TAILSCALE_AUTHKEY=tailscale-authkey:latest,TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,OPENCLAW_GATEWAY_TOKEN=openclaw-gateway-key:latest,GOG_KEYRING_PASSWORD=gog-keyring-password:latest,GOG_ACCOUNT=gog-account:latest"
if ($LASTEXITCODE -ne 0) { throw "Instance deploy failed" }

gcloud beta run instances describe $Instance --project $Project --region $Region
