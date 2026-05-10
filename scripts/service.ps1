#
# im-to-agent 系统服务管理脚本（Windows 计划任务）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\service.ps1 <install|uninstall|status|logs>
#

param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "uninstall", "status", "logs", "")]
    [string]$Command
)

$ErrorActionPreference = "Stop"

$TaskName = "im-to-agent"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $ProjectDir "logs"
$EntryPoint = Join-Path $ProjectDir "dist\index.js"
$ConfigFile = Join-Path $ProjectDir "config.json"
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source

function Show-Usage {
    Write-Host "用法: powershell -ExecutionPolicy Bypass -File scripts\service.ps1 <command>"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  install    编译项目并注册为系统服务（开机自启）"
    Write-Host "  uninstall  卸载系统服务"
    Write-Host "  status     查看服务运行状态"
    Write-Host "  logs       实时查看服务日志"
}

function Stop-ServiceProcess {
    # 查找并杀掉 wrapper 脚本启动的 node 进程（通过 EntryPoint 路径匹配）
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match [regex]::Escape($EntryPoint) }
    if ($procs) {
        foreach ($p in $procs) {
            Write-Host "  停止残留进程 PID=$($p.ProcessId)..."
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }

    # wrapper 脚本通过隐藏的 powershell 启动 node，CommandLine 可能为空
    # 通过 .service-runner.ps1 的父 powershell 进程查找
    $wrapperScript = Join-Path $ProjectDir "scripts\.service-runner.ps1"
    $parentProcs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -match [regex]::Escape($wrapperScript) }
    foreach ($pp in $parentProcs) {
        # 杀掉子进程（node）
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($pp.ProcessId)" |
            ForEach-Object {
                Write-Host "  停止子进程 PID=$($_.ProcessId)..."
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        Write-Host "  停止父进程 PID=$($pp.ProcessId)..."
        Stop-Process -Id $pp.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Install-Service {
    if (-not $NodePath) {
        Write-Error "错误: 未找到 node，请确保 Node.js 已安装并在 PATH 中"
        exit 1
    }

    Write-Host "==> 安装依赖..."
    Push-Location $ProjectDir
    npm install
    Write-Host "==> 编译项目..."
    npm run build
    Pop-Location

    if (-not (Test-Path $ConfigFile)) {
        Write-Error "错误: 未找到 config.json，请先复制 config.json.example 并填入配置"
        exit 1
    }

    if (-not (Test-Path $EntryPoint)) {
        Write-Error "错误: 编译产物 dist\index.js 不存在"
        exit 1
    }

    Write-Host "==> 创建日志目录..."
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir | Out-Null
    }

    # 如果任务已存在，先停止进程并卸载
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "==> 检测到已有服务，先卸载..."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Stop-ServiceProcess
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    # 用一个 wrapper 脚本来设置工作目录并重定向输出
    $wrapperScript = Join-Path $ProjectDir "scripts\.service-runner.ps1"

    $wrapperContent = @"
# 自动生成的服务启动脚本，请勿手动编辑
`$ErrorActionPreference = "Stop"
Set-Location "$ProjectDir"

# 用 cmd 启动 node 并重定向日志，避免 PowerShell *> 生成 UTF-16LE
cmd /c "`"$NodePath`" `"$EntryPoint`" > `"$LogDir\output.log`" 2>&1"
"@
    Set-Content -Path $wrapperScript -Value $wrapperContent -Encoding UTF8

    Write-Host "==> 注册计划任务..."

    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperScript`"" `
        -WorkingDirectory $ProjectDir

    # 用户登录时自动启动
    $trigger = New-ScheduledTaskTrigger -AtLogOn

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 9999)

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description "im-to-agent 桥接服务" `
        -RunLevel Highest | Out-Null

    # 立即启动
    Write-Host "==> 启动服务..."
    Start-ScheduledTask -TaskName $TaskName

    Write-Host ""
    Write-Host "安装完成！服务已启动。"
    Write-Host "  查看状态: powershell scripts\service.ps1 status"
    Write-Host "  查看日志: powershell scripts\service.ps1 logs"
    Write-Host "  卸载服务: powershell scripts\service.ps1 uninstall"
}

function Uninstall-Service {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "服务未安装"
        return
    }

    Write-Host "==> 停止服务..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServiceProcess

    Write-Host "==> 卸载服务..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

    # 清理生成的 wrapper 脚本
    $wrapperScript = Join-Path $ProjectDir "scripts\.service-runner.ps1"
    if (Test-Path $wrapperScript) {
        Remove-Item $wrapperScript
    }

    Write-Host "服务已卸载"
}

function Get-ServiceStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "服务未安装"
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "服务状态: $($task.State)"
    Write-Host "上次运行: $($info.LastRunTime)"
    Write-Host "上次结果: $($info.LastTaskResult)"
}

function Show-Logs {
    $logFile = Join-Path $LogDir "output.log"
    if (-not (Test-Path $logFile)) {
        Write-Host "暂无日志文件，服务可能尚未启动过"
        return
    }

    Write-Host "==> 日志输出 (Ctrl+C 退出)"
    Get-Content $logFile -Wait -Tail 50
}

switch ($Command) {
    "install"   { Install-Service }
    "uninstall" { Uninstall-Service }
    "status"    { Get-ServiceStatus }
    "logs"      { Show-Logs }
    default     { Show-Usage; exit 1 }
}
