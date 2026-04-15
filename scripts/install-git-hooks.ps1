$ErrorActionPreference = 'Stop'

git config core.hooksPath .githooks
Write-Host 'Git hooks installed: core.hooksPath=.githooks'
