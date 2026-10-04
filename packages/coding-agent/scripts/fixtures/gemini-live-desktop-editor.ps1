param(
    [Parameter(Mandatory = $true)]
    [string] $WindowTitle,

    [Parameter(Mandatory = $true)]
    [string] $OutputPath,

    [Parameter(Mandatory = $true)]
    [string] $ReadyPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$form = New-Object System.Windows.Forms.Form
$form.Text = $WindowTitle
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = New-Object System.Drawing.Size(760, 440)
$form.MinimumSize = New-Object System.Drawing.Size(480, 320)
$form.ShowInTaskbar = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = "Owned Gemini Live desktop smoke editor"
$label.Dock = [System.Windows.Forms.DockStyle]::Top
$label.Height = 32
$label.Padding = New-Object System.Windows.Forms.Padding(8, 8, 0, 0)

$editor = New-Object System.Windows.Forms.TextBox
$editor.Name = "GeminiLiveSmokeEditor"
$editor.AccessibleName = "Gemini Live owned editor"
$editor.Multiline = $true
$editor.AcceptsReturn = $true
$editor.AcceptsTab = $false
$editor.ScrollBars = [System.Windows.Forms.ScrollBars]::Both
$editor.WordWrap = $false
$editor.Dock = [System.Windows.Forms.DockStyle]::Fill
$editor.Font = New-Object System.Drawing.Font("Consolas", 14)

$utf8 = New-Object System.Text.UTF8Encoding($false)
$editor.Add_TextChanged({
    [System.IO.File]::WriteAllText($OutputPath, $editor.Text, $utf8)
})

$form.Controls.Add($editor)
$form.Controls.Add($label)
$form.Add_Shown({
    $form.Activate()
    $editor.Focus()
    [System.IO.File]::WriteAllText($ReadyPath, [string][System.Diagnostics.Process]::GetCurrentProcess().Id, $utf8)
})

try {
    [System.IO.File]::WriteAllText($OutputPath, "", $utf8)
    [System.Windows.Forms.Application]::Run($form)
}
finally {
    $editor.Dispose()
    $label.Dispose()
    $form.Dispose()
}
