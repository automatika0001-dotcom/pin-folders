# Pin Folders: push an update to GitHub in one go.
#
# Put this file in your pin-folders repo folder (the one you cloned from GitHub).
# Right-click it > Run with PowerShell. It will:
#   1. find the newest pin-folders*.zip in your Downloads (or a zip path you pass to it)
#   2. copy its contents into this repo
#   3. commit and push to GitHub (Cloudflare updates the server automatically)
#   4. if the app version changed, tag it so GitHub builds and publishes the new installer

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host ""
    Write-Host "ERROR: $msg" -ForegroundColor Red
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# Your GitHub repository. Used to connect this folder to GitHub the first time.
$RepoUrl = 'https://github.com/automatika0001-dotcom/pin-folders.git'

$repo = $PSScriptRoot
Set-Location $repo

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "Git is not installed. Run:  winget install Git.Git   then close and reopen, and try again."
}

# First run in a plain folder (not cloned): link it to GitHub, keeping the files here.
if (-not (Test-Path (Join-Path $repo '.git'))) {
    Step "Connecting this folder to GitHub (first run only)"
    git init -q
    git remote add origin $RepoUrl
    git fetch -q origin
    if ($LASTEXITCODE -ne 0) {
        Remove-Item (Join-Path $repo '.git') -Recurse -Force -ErrorAction SilentlyContinue
        Fail "Couldn't reach $RepoUrl. Check your internet connection and that the repo exists, then try again."
    }
    git symbolic-ref HEAD refs/heads/main
    git reset -q origin/main
    git branch -q -u origin/main
    Write-Host "Connected. This folder is now your repo." -ForegroundColor Green
}

# ---------- find the update zip ----------
$zip = $null
if ($args.Count -gt 0 -and (Test-Path $args[0])) {
    $zip = (Resolve-Path $args[0]).Path
} else {
    $found = Get-ChildItem -Path (Join-Path $HOME 'Downloads') -Filter 'pin-folders*.zip' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $zip = $found.FullName }
}
if (-not $zip) {
    Fail "No pin-folders*.zip found in Downloads. Download the latest one first."
}

$zipInfo = Get-Item $zip
Write-Host ""
Write-Host "Update file: $($zipInfo.Name)" -ForegroundColor Yellow
Write-Host "Downloaded:  $($zipInfo.LastWriteTime)"
Write-Host "Repo folder: $repo"
Write-Host ""
Read-Host "Press Enter to push this update (or close the window to cancel)"

# ---------- unpack ----------
Step "Unpacking"
$tmp = Join-Path $env:TEMP 'pin-folders-update'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$src = Join-Path $tmp 'pin-folders'
if (-not (Test-Path (Join-Path $src 'app'))) {
    if (Test-Path (Join-Path $tmp 'app')) { $src = $tmp }
    else { Fail "That zip doesn't look like a Pin Folders update (no app folder inside)." }
}

# ---------- sync ----------
Step "Getting the latest from GitHub"
git pull --ff-only
if ($LASTEXITCODE -ne 0) { Fail "git pull failed. If you edited files on GitHub's website, that's usually why; tell Claude the message above." }

Step "Copying the update into the repo"
robocopy $src $repo /MIR /XD .git node_modules .wrangler dist /XF push-update.ps1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copying files failed (robocopy code $LASTEXITCODE)." }

$version = (Get-Content (Join-Path $repo 'app\package.json') -Raw | ConvertFrom-Json).version

Step "Committing"
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
    Write-Host "No file changes compared to GitHub." -ForegroundColor Yellow
} else {
    git -c user.name="Pin Folders" -c user.email="pinfolders@users.noreply.github.com" commit -m "Update to v$version" | Out-Null
    Step "Pushing to GitHub"
    git push
    if ($LASTEXITCODE -ne 0) { Fail "git push failed. Check the message above (you may need to sign in to GitHub)." }
    Write-Host "Pushed. Cloudflare will update the server within a minute." -ForegroundColor Green
}

# ---------- publish the app if the version is new ----------
$tag = "v$version"
$exists = git ls-remote --tags origin "refs/tags/$tag"
if ($exists) {
    Write-Host ""
    Write-Host "App version $version is already published, so no new installer is built." -ForegroundColor Yellow
    Write-Host "(That's expected when only the server changed.)"
} else {
    Step "Publishing app $tag"
    git tag $tag
    git push origin $tag
    if ($LASTEXITCODE -ne 0) { Fail "Pushing the version tag failed." }
    Write-Host "GitHub is now building the $tag installer (about 5 minutes)." -ForegroundColor Green
    Write-Host "Everyone's panel will update itself once it's done."
}

# Open the build page so you can watch it.
$remote = (git remote get-url origin).Trim() -replace '\.git$', ''
if ($remote -match '^git@github\.com:(.+)$') { $remote = "https://github.com/$($Matches[1])" }
if ($remote -match '^https://github\.com/') { Start-Process "$remote/actions" }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "All done." -ForegroundColor Green
Read-Host "Press Enter to close"
