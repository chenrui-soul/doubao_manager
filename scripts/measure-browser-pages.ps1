param([switch]$After)
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'
$health = Invoke-RestMethod "$base/health"
if ($health.queue.active -ne 0 -or $health.queue.waiting -ne 0) { throw 'Active tasks detected; page measurement deferred' }
$serviceInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($health.pid)"
$desktopId = $serviceInfo.ParentProcessId
$accounts = @((Invoke-RestMethod "$base/api/v1/accounts").accounts | Select-Object -First 4)
$samples = @()
foreach ($account in $accounts) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $opened = Invoke-RestMethod "$base/api/v1/accounts/$($account.id)/login" -Method Post -TimeoutSec 100
    $watch.Stop()
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq $desktopId -or $_.ParentProcessId -eq $desktopId })
    $renderers = @($processes | Where-Object { $_.CommandLine -like '*--type=renderer*' })
    $samples += [pscustomobject]@{
        accountId = $account.id
        openMs = $watch.ElapsedMilliseconds
        loginState = $opened.account.loginState
        rendererProcesses = $renderers.Count
        totalWorkingSetMB = [math]::Round(($processes | Measure-Object WorkingSetSize -Sum).Sum / 1MB, 1)
        providerRendererWorkingSetMB = [math]::Round(($renderers | Measure-Object WorkingSetSize -Sum).Sum / 1MB, 1)
        visibleSessions = @($opened.result.accounts | Where-Object { $_ -and -not $_.automation }).Count
        automationSessions = @($opened.result.accounts | Where-Object { $_.automation }).Count
        domReadyMs = $opened.result.current.domReadyMs
        pageLoadMs = $opened.result.current.pageLoadMs
    }
}
$tag = if ($After) { 'after' } else { 'before' }
$logDir = Join-Path $PSScriptRoot 'log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
[pscustomobject]@{at=(Get-Date).ToString('o'); samples=$samples; note='Renderer count includes the one desktop UI renderer. Working set is a snapshot; generation was not requested.'} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $logDir "browser-pages-$tag.json") -Encoding utf8
$samples | Format-Table accountId,openMs,domReadyMs,pageLoadMs,loginState,rendererProcesses,totalWorkingSetMB,visibleSessions,automationSessions
