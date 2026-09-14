param(
  [switch]$RequireSignature
)

$ErrorActionPreference = "Stop"
$desktop = "dist/desktop/win-unpacked/ChatGPT Orchestra.exe"
$extension = "dist/alpha-extension/manifest.json"
$installer = Get-ChildItem "dist/desktop" -Filter "*.exe" -File |
  Where-Object { $_.FullName -ne (Resolve-Path $desktop -ErrorAction SilentlyContinue) } |
  Select-Object -First 1

if (!(Test-Path $desktop -PathType Leaf)) { throw "missing_alpha_desktop_executable:$desktop" }
if (!(Test-Path $extension -PathType Leaf)) { throw "missing_alpha_extension_manifest:$extension" }
if (!$installer) { throw "missing_alpha_windows_installer" }

$manifest = Get-Content $extension -Raw | ConvertFrom-Json
if ($manifest.version_name -ne "2.0.0-alpha.20") { throw "alpha_extension_version_mismatch" }

$signatureEvidence = @()
foreach ($signedFile in @((Resolve-Path $desktop).Path, $installer.FullName)) {
  $signature = Get-AuthenticodeSignature $signedFile
  $status = [string]$signature.Status
  $subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
  Write-Host "Authenticode $signedFile => $status; signer=$subject"

  if ($status -notin @("Valid", "NotSigned")) {
    throw "alpha_windows_signature_invalid:${signedFile}:$status"
  }
  if ($RequireSignature -and ($status -ne "Valid" -or !$signature.SignerCertificate)) {
    throw "alpha_windows_signature_required:${signedFile}:$status"
  }

  $signatureEvidence += [ordered]@{
    file = Split-Path $signedFile -Leaf
    status = $status
    signerSubject = $subject
  }
}

$evidence = [ordered]@{
  schemaVersion = 1
  version = [string]$manifest.version_name
  requireSignature = [bool]$RequireSignature
  installer = [string]$installer.Name
  signatures = $signatureEvidence
}
$evidencePath = "dist/desktop/alpha-signature-evidence.json"
$evidence | ConvertTo-Json -Depth 5 | Set-Content -Path $evidencePath -Encoding utf8

if (!$RequireSignature -and ($signatureEvidence | Where-Object { $_.status -eq "NotSigned" })) {
  Write-Warning "Unsigned PR/CI alpha candidate detected. Final release validation requires Authenticode=Valid."
}

Write-Host "alpha installer: $($installer.FullName)"
Write-Host "signature evidence: $evidencePath"
