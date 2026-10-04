param(
    [Parameter(Mandatory = $true)]
    [string] $WindowTitle,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath,

    [Parameter(Mandatory = $true)]
    [string] $ReadyPath
)

$ErrorActionPreference = "Stop"
Write-Output "Compiling owned Windows GUI fixture"
# CLR event handlers keep the GUI message loop independent of PowerShell's runspace.
# ThrowException surfaces GUI errors to stderr rather than opening a blocking dialog.
Add-Type -Path (Join-Path $PSScriptRoot "gemini-live-desktop-editor.cs") -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing")
Write-Output "Starting owned Windows GUI fixture"
[OmpGeminiLiveDesktopEditor]::Run($WindowTitle, $OutputPath, $ReadyPath)
