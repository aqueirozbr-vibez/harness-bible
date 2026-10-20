<#
.SYNOPSIS
  Registers the two nightly jobs of infra/schedules/README.md as Windows scheduled tasks on the development
  machine (feature-specs/21 section 3.1, decision D1). The Linux host uses infra/schedules/crontab instead.

.PARAMETER AppDir
  The application checkout. Defaults to the repository this script sits in.

.PARAMETER DryRun
  Prints what would be registered and changes nothing.

.PARAMETER Unregister
  Removes the two tasks.
#>
param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$DryRun,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

$jobs = @(
  @{ Name = "HarnessBible assistant purge"; Script = "assistant:purge"; At = "03:10"; Log = "purge.log"; About = "Nightly retention: message text is kept 30 days (feature-specs/21)." },
  @{ Name = "HarnessBible auth sweep"; Script = "auth:sweep"; At = "03:20"; Log = "sweep.log"; About = "Nightly sweep of expired sessions, idempotency keys, rate buckets and audit rows." }
)
$logDir = Join-Path $env:LOCALAPPDATA "harness-bible\logs"

foreach ($job in $jobs) {
  if ($Unregister) {
    if ($DryRun) { Write-Output "would unregister '$($job.Name)'"; continue }
    try {
      Unregister-ScheduledTask -TaskName $job.Name -Confirm:$false -ErrorAction Stop
      Write-Output "unregistered '$($job.Name)'"
    } catch {
      Write-Output "'$($job.Name)' was not registered"
    }
    continue
  }

  $command = "cd /d `"$AppDir`" && npm run $($job.Script) >> `"$logDir\$($job.Log)`" 2>&1"
  if ($DryRun) {
    Write-Output "would register '$($job.Name)' daily at $($job.At): cmd.exe /c $command"
    continue
  }

  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $command"
  $trigger = New-ScheduledTaskTrigger -Daily -At $job.At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $job.Name -Action $action -Trigger $trigger -Settings $settings -Description $job.About -Force | Out-Null
  Write-Output "registered '$($job.Name)' daily at $($job.At), logging to $logDir\$($job.Log)"
}
