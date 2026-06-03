Clear-Host
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "🚀 RETROPLAY PORTAL - CLOUD DEPLOYMENT HELPER 🚀" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "This script will help you push this project to your GitHub account" -ForegroundColor Cyan
Write-Host "so that you can host it 24/7 in the cloud (using Render or Railway)!" -ForegroundColor Cyan
Write-Host ""
Write-Host "Before proceeding, please make sure:" -ForegroundColor Yellow
Write-Host "1. You have created a new empty repository on your GitHub account." -ForegroundColor Yellow
Write-Host "2. You have your GitHub repository URL ready (e.g., https://github.com/username/repo.git)." -ForegroundColor Yellow
Write-Host ""

$repoUrl = Read-Host "Enter your GitHub Repository URL (or press Enter to cancel)"

if ([string]::IsNullOrWhiteSpace($repoUrl)) {
    Write-Host "Deployment helper canceled." -ForegroundColor Yellow
    exit
}

# Clean any existing remote origins
git remote remove origin 2>$null

# Add new origin
Write-Host "Linking local repository to: $repoUrl ..." -ForegroundColor Cyan
git remote add origin $repoUrl
git branch -M main

Write-Host "Pushing code to GitHub..." -ForegroundColor Cyan
git push -u origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "🎉 Success! The code has been successfully pushed to GitHub." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next Steps for 24/7 Hosting:" -ForegroundColor Green
    Write-Host "1. Log into your Render.com account." -ForegroundColor Green
    Write-Host "2. Create a new 'Web Service' and link it to this GitHub repository." -ForegroundColor Green
    Write-Host "3. Render will automatically detect 'render.yaml' and build/deploy your portal instantly!" -ForegroundColor Green
    Write-Host "4. Render will provide a FREE secure HTTPS link (with green lock) that works on all devices." -ForegroundColor Green
} else {
    Write-Host "Error: Could not push code to GitHub. Please make sure git credentials are configured on this PC." -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to exit..."
