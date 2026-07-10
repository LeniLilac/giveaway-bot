$ErrorActionPreference = "Stop"

$project = $env:DOPPLER_PROJECT
if (-not $project) { $project = "giveaway-bot" }
$config = $env:DOPPLER_CONFIG
if (-not $config) { $config = "dev" }

doppler run --project $project --config $config -- npm run dev
