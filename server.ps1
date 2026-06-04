# ==============================================================================
# 🎮  MGE (Mamdouh Game Emulator) STANDALONE POWERSHELL SERVER  🎮
# ==============================================================================
# This is a native Windows PowerShell backend server designed specifically for 
# running the MGE Emulator Portal without requiring Node.js or NPM installed!
# Features: Static File Serving, Custom DB, PBKDF2 Cryptography, & Secure API Routes.
# ==============================================================================

$port = 3001
$backendPort = 3002
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$backendPort/")
$listener.Prefixes.Add("http://127.0.0.1:$backendPort/")

$baseDir = Get-Location
$publicDir = Join-Path $baseDir "public"
$downloadsDir = Join-Path $baseDir "downloads"
$uploadsDir = Join-Path $baseDir "uploads"
$dbPath = Join-Path $baseDir "database.json"

# Ensure directories exist
if (!(Test-Path $downloadsDir)) { New-Item -ItemType Directory -Path $downloadsDir | Out-Null }
if (!(Test-Path $uploadsDir)) { New-Item -ItemType Directory -Path $uploadsDir | Out-Null }

# Prepopulate dummy local downloads
$dummyFiles = @(
    @{ Name = "AetherSX2_PS2_Android.apk"; Content = "Mock AetherSX2 Android APK File" },
    @{ Name = "PPSSPP_PSP_Android.apk"; Content = "Mock PPSSPP Android APK File" },
    @{ Name = "PCSX2_PS2_Windows.exe"; Content = "Mock PCSX2 Windows Executable File" },
    @{ Name = "RPCS3_PS3_Windows.zip"; Content = "Mock RPCS3 Windows Zip File" }
)
foreach ($f in $dummyFiles) {
    $path = Join-Path $downloadsDir $f.Name
    if (!(Test-Path $path)) { Set-Content -Path $path -Value $f.Content }
}

# Auto-copy generated background image if present in brain
try {
    $brainDir = "C:\Users\LionPower\.gemini\antigravity\brain\5c60eaef-3982-4d29-b5fb-74bc810b7bcc"
    $destImage = Join-Path $publicDir "gaming_room_bg.png"
    if (Test-Path $brainDir) {
        $files = Get-ChildItem -Path $brainDir -Filter "gaming_room_bg_*.png" | Sort-Object LastWriteTime -Descending
        if ($files.Count -gt 0) {
            Copy-Item -Path $files[0].FullName -Destination $destImage -Force
            Write-Host "🎨 Beautiful Gaming Room Background copied successfully!" -ForegroundColor Green
        }
    }
} catch {
    Write-Host "Could not copy background image: $_" -ForegroundColor Yellow
}

# In-Memory Active Sessions & Rate Limiting
$activeSessions = @{} # Token -> { username, expiresAt }
$loginAttempts = @{}  # IP -> { count, lastAttempt }

# Core Security Provider Helper
# Complies with .NET 4.8 / Windows PowerShell 5.1 out-of-the-box using compiled C# helper for maximum performance!
if ($null -eq ("SecurityProvider" -as [type])) {
    $Source = @"
    using System;
    using System.Security.Cryptography;
    using System.Text;

    public class SecurityProvider {
        public static string HashPassword(string password, string saltHex, int iterations) {
            byte[] saltBytes = HexToBytes(saltHex);
            byte[] passwordBytes = Encoding.UTF8.GetBytes(password);
            
            using (var hmac = new HMACSHA512(passwordBytes)) {
                byte[] block1Input = new byte[saltBytes.Length + 4];
                Buffer.BlockCopy(saltBytes, 0, block1Input, 0, saltBytes.Length);
                block1Input[block1Input.Length - 1] = 1;
                
                byte[] u = hmac.ComputeHash(block1Input);
                byte[] t = (byte[])u.Clone();
                
                for (int i = 2; i <= iterations; i++) {
                    u = hmac.ComputeHash(u);
                    for (int j = 0; j < t.Length; j++) {
                        t[j] ^= u[j];
                    }
                }
                
                StringBuilder sb = new StringBuilder(t.Length * 2);
                foreach (byte b in t) {
                    sb.Append(b.ToString("x2"));
                }
                return sb.ToString();
            }
        }
        
        private static byte[] HexToBytes(string hex) {
            int len = hex.Length;
            byte[] bytes = new byte[len / 2];
            for (int i = 0; i < len; i += 2) {
                bytes[i / 2] = Convert.ToByte(hex.Substring(i, 2), 16);
            }
            return bytes;
        }
    }
"@
    Add-Type -TypeDefinition $Source
}

if ($null -eq ("TcpProxy" -as [type])) {
    $proxySource = @"
    using System;
    using System.IO;
    using System.Net;
    using System.Net.Security;
    using System.Net.Sockets;
    using System.Security.Cryptography.X509Certificates;
    using System.Text;
    using System.Threading.Tasks;

    public class TcpProxy {
        private TcpListener _listener;
        private int _targetPort;
        private string _targetHost;
        private X509Certificate2 _cert;
        private bool _running;

        public TcpProxy(int listenPort, string targetHost, int targetPort, X509Certificate2 cert) {
            _listener = new TcpListener(IPAddress.Any, listenPort);
            _targetHost = targetHost;
            _targetPort = targetPort;
            _cert = cert;
        }

        public void Start() {
            _running = true;
            _listener.Start();
            Task t = Task.Run(() => AcceptConnectionsAsync());
        }

        public void Stop() {
            _running = false;
            try { _listener.Stop(); } catch {}
        }

        private async Task AcceptConnectionsAsync() {
            while (_running) {
                try {
                    TcpClient client = await _listener.AcceptTcpClientAsync();
                    Task t = Task.Run(() => HandleClientAsync(client));
                }
                catch {
                    if (!_running) break;
                }
            }
        }

        private async Task HandleClientAsync(TcpClient client) {
            using (client) {
                try {
                    byte[] prefix = new byte[1];
                    int peeked = client.Client.Receive(prefix, 0, 1, SocketFlags.Peek);
                    if (peeked <= 0) return;

                    bool isSsl = (prefix[0] == 0x16);
                    Stream activeClientStream = client.GetStream();

                    if (isSsl && _cert != null) {
                        SslStream sslStream = new SslStream(activeClientStream, false);
                        await sslStream.AuthenticateAsServerAsync(_cert, false, System.Security.Authentication.SslProtocols.Tls12, false);
                        activeClientStream = sslStream;
                    }

                    using (TcpClient targetClient = new TcpClient()) {
                        await targetClient.ConnectAsync(_targetHost, _targetPort);
                        using (NetworkStream targetStream = targetClient.GetStream()) {
                            Task copyTargetToClient = targetStream.CopyToAsync(activeClientStream);

                            byte[] buffer = new byte[8192];
                            int bytesRead = await activeClientStream.ReadAsync(buffer, 0, buffer.Length);
                            if (bytesRead > 0) {
                                string request = Encoding.UTF8.GetString(buffer, 0, bytesRead);
                                int hostIndex = request.IndexOf("Host:", StringComparison.OrdinalIgnoreCase);
                                if (hostIndex >= 0) {
                                    int lineEndIndex = request.IndexOf("\r\n", hostIndex);
                                    if (lineEndIndex > hostIndex) {
                                        string hostLine = request.Substring(hostIndex, lineEndIndex - hostIndex);
                                        string originalHost = hostLine.Substring(5).Trim();
                                        
                                        string newHostLine = "Host: " + _targetHost + ":" + _targetPort;
                                        string xForwardedLine = "\r\nX-Forwarded-Host: " + originalHost;
                                        
                                        request = request.Substring(0, hostIndex) + newHostLine + xForwardedLine + request.Substring(lineEndIndex);
                                    }
                                }
                                byte[] modifiedBuffer = Encoding.UTF8.GetBytes(request);
                                await targetStream.WriteAsync(modifiedBuffer, 0, modifiedBuffer.Length);
                                await activeClientStream.CopyToAsync(targetStream);
                            }

                            await copyTargetToClient;
                        }
                    }
                }
                catch (Exception ex) {
                    Console.WriteLine("Proxy Client Error: " + ex.ToString());
                    if (ex.InnerException != null) {
                        Console.WriteLine("Proxy Client Inner Error: " + ex.InnerException.ToString());
                    }
                }
            }
        }
    }
"@
    Add-Type -TypeDefinition $proxySource
}

function Hash-Password($password, $saltHex) {
    return [SecurityProvider]::HashPassword($password, $saltHex, 210000)
}

function Generate-Salt {
    $bytes = [byte[]]::new(16)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $hex = ""
    foreach ($b in $bytes) { $hex += $b.ToString("x2") }
    return $hex
}

# DB Load & Save Engine
function Load-DB {
    $db = $null
    if (Test-Path $dbPath) {
        $raw = Get-Content -Raw -Path $dbPath -ErrorAction SilentlyContinue
        if ($raw -and $raw.Trim().StartsWith("{")) {
            try {
                $db = ConvertFrom-Json $raw
            } catch {}
        }
    }
    
    # If DB failed to load, or users list is empty, initialize default seeds!
    if (!$db -or !$db.users -or $db.users.Count -eq 0) {
        Write-Host "Initializing brand-new persistent database seeds..." -ForegroundColor Cyan
        $adminSalt = Generate-Salt
        $adminHash = Hash-Password "admin" $adminSalt
        
        $mamdouhSalt = Generate-Salt
        $mamdouhHash = Hash-Password "mamdouh10@" $mamdouhSalt

        $guestSalt = Generate-Salt
        $guestHash = Hash-Password "guest" $guestSalt
        
        $db = [ordered]@{
            users = @(
                [ordered]@{
                    username = "admin"
                    email = "admin@mge.com"
                    passwordHash = $adminHash
                    salt = $adminSalt
                    webauthnCredentialId = $null
                },
                [ordered]@{
                    username = "mamdouh"
                    email = "mamdouh1626@gmail.com"
                    passwordHash = $mamdouhHash
                    salt = $mamdouhSalt
                    webauthnCredentialId = $null
                },
                [ordered]@{
                    username = "guest"
                    email = "guest@mge.com"
                    passwordHash = $guestHash
                    salt = $guestSalt
                    webauthnCredentialId = $null
                }
            )
            roms = @(
                [ordered]@{
                    id = "rom_pre1"
                    name = "Galaxy Striker 1999 (محاكي فضاء ثلاثي الأبعاد)"
                    size = 14502390
                    filename = "galaxy_striker_1999.bin"
                    uploadDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    console = "PS1"
                    preloaded = $true
                },
                [ordered]@{
                    id = "rom_pre2"
                    name = "Formula Retro Racing (لعبة سباق سيارات كلاسيكية)"
                    size = 18902422
                    filename = "formula_retro_racing.bin"
                    uploadDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    console = "PS1"
                    preloaded = $true
                },
                [ordered]@{
                    id = "rom_pre3"
                    name = "Memory Card Manager (أداة تهيئة كروت الذاكرة)"
                    size = 4501239
                    filename = "memory_card_manager.bin"
                    uploadDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    console = "PS1"
                    preloaded = $true
                }
            )
            saves = @()
        }
        Save-DB $db
    }
    
    # Ensure all tables exist in loaded DB
    if ($null -eq $db.PSObject.Properties['users']) { $db | Add-Member -MemberType NoteProperty -Name "users" -Value @() }
    if ($null -eq $db.PSObject.Properties['roms']) { $db | Add-Member -MemberType NoteProperty -Name "roms" -Value @() }
    if ($null -eq $db.PSObject.Properties['saves']) { $db | Add-Member -MemberType NoteProperty -Name "saves" -Value @() }
    
    # Persistent configuration and local installed games (New features!)
    if ($null -eq $db.PSObject.Properties['system_config']) { 
        $config = [ordered]@{ portal_name = "MGE STATION" }
        $db | Add-Member -MemberType NoteProperty -Name "system_config" -Value $config 
    }
    if ($null -eq $db.PSObject.Properties['local_apps']) { 
        $apps = @(
            [ordered]@{
                id = "local_app_1"
                name = "Minecraft PE"
                package = "com.mojang.minecraftpe"
                icon = "🧱"
                platform = "Android"
            },
            [ordered]@{
                id = "local_app_2"
                name = "GTA San Andreas"
                package = "com.rockstargames.gtasa"
                icon = "🚗"
                platform = "Android"
            }
        )
        $db | Add-Member -MemberType NoteProperty -Name "local_apps" -Value $apps 
    }
    
    # Ensure mallea user exists in the database
    $hasMallea = $db.users | Where-Object { $_.username.ToLower() -eq "mallea" }
    if (!$hasMallea) {
        $malleaSalt = Generate-Salt
        $malleaHash = Hash-Password "mallea10@" $malleaSalt
        $malleaUser = [ordered]@{
            username = "mallea"
            email = "mallea@retroplay.com"
            passwordHash = $malleaHash
            salt = $malleaSalt
            webauthnCredentialId = $null
        }
        $db.users = @($db.users) + $malleaUser
        Save-DB $db
    }
    
    return $db
}

function Save-DB($dbData) {
    $json = ConvertTo-Json $dbData -Depth 10 -Compress
    Set-Content -Path $dbPath -Value $json -Encoding utf8
}

# Start listening
$sslCert = $null
try {
    # Search for existing certificate using array wrapper to avoid single-object .Count issue
    $certs = @(Get-ChildItem -Path "cert:\CurrentUser\My" | Where-Object { $_.FriendlyName -eq "MGE Portal SSL v3" })
    if ($certs.Length -gt 0) {
        $sslCert = $certs[0]
    } else {
        # Generate new self-signed certificate with proper IP SANs using modern .NET CertificateRequest
        try {
            $hostName = [System.Net.Dns]::GetHostName()
            $lanIps = [System.Net.Dns]::GetHostAddresses($hostName) | 
                Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | 
                Select-Object -ExpandProperty IPAddressToString

            $primaryIp = "127.0.0.1"
            foreach ($ip in $lanIps) {
                if ($ip -notlike "127.*" -and $ip -notlike "169.254.*") {
                    $primaryIp = $ip
                    break
                }
            }

            $sanBuilder = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
            $sanBuilder.AddDnsName("localhost")
            $sanBuilder.AddDnsName($hostName)
            $sanBuilder.AddDnsName("mallea")
            $sanBuilder.AddDnsName("mallea.local")
            $sanBuilder.AddDnsName("mallea.com")
            
            $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
            $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("::1"))
            foreach ($ip in $lanIps) {
                if ($ip -notlike "127.*" -and $ip -notlike "169.254.*") {
                    $sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse($ip))
                }
            }

            $subject = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName("CN=$primaryIp, O=RetroPlay, CN=$primaryIp")
            $rsa = [System.Security.Cryptography.RSA]::Create(2048)
            $request = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest($subject, $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)

            $ekuOids = New-Object System.Security.Cryptography.OidCollection
            [void]$ekuOids.Add((New-Object System.Security.Cryptography.Oid("1.3.6.1.5.5.7.3.1")))
            $eku = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension($ekuOids, $false)
            [void]$request.CertificateExtensions.Add($eku)

            $keyUsageFlags = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]160
            $keyUsage = New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension($keyUsageFlags, $true)
            [void]$request.CertificateExtensions.Add($keyUsage)

            $sanExtension = $sanBuilder.Build()
            [void]$request.CertificateExtensions.Add($sanExtension)

            $basicConstraints = New-Object System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension($false, $false, 0, $false)
            [void]$request.CertificateExtensions.Add($basicConstraints)

            $notBefore = [DateTimeOffset]::Now.AddDays(-1)
            $notAfter = $notBefore.AddDays(820)
            $cert = $request.CreateSelfSigned($notBefore, $notAfter)

            $pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, "mallea_portal")
            $keyStorageFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]21
            $persistedCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfxBytes, "mallea_portal", $keyStorageFlags)
            $persistedCert.FriendlyName = "MGE Portal SSL v3"

            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "CurrentUser")
            $store.Open("ReadWrite")
            $store.Add($persistedCert)
            $store.Close()

            $sslCert = $persistedCert
        } catch {
            Write-Host "Warning: Modern certificate generation failed. Falling back to legacy method: $_" -ForegroundColor Yellow
            $hostName = [System.Net.Dns]::GetHostName()
            $dnsNames = @("localhost", "127.0.0.1", "::1", $hostName)
            try {
                $lanIps = [System.Net.Dns]::GetHostAddresses($hostName) | 
                    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | 
                    Select-Object -ExpandProperty IPAddressToString
                foreach ($lanIp in $lanIps) {
                    if ($lanIp -notlike "127.*" -and $lanIp -notlike "169.254.*") { $dnsNames += $lanIp }
                }
            } catch {}
            $sslCert = New-SelfSignedCertificate -DnsName $dnsNames -CertStoreLocation "cert:\CurrentUser\My" -FriendlyName "MGE Portal SSL v3" -Provider "Microsoft RSA SChannel Cryptographic Provider" -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(2) -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Host "Warning: Could not create or load SSL certificate: $_" -ForegroundColor Yellow
}

if ($sslCert) {
    try {
        $certFilePath = Join-Path $publicDir "mallea_portal.cer"
        [System.IO.File]::WriteAllBytes($certFilePath, $sslCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    } catch {}
}

try {
    $listener.Start()
    $proxy = [TcpProxy]::new($port, "127.0.0.1", $backendPort, $sslCert)
    $proxy.Start()
    Write-Host "Backend server started successfully on port $backendPort." -ForegroundColor Green
    if ($sslCert) {
        Write-Host "SSL Active! Auto-detecting HTTP & HTTPS on port $port." -ForegroundColor Green
    } else {
        Write-Host "HTTP Only Active on port $port." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Critical: Could not start listener or proxy: $_" -ForegroundColor Red
    Exit
}
Clear-Host
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "🎮 MGE PORTAL STANDALONE POWERED BY POWERSHELL ACTIVE! 🎮" -ForegroundColor Green
Write-Host "📡 Server Address: https://localhost:$port/ (or http://localhost:$port/)" -ForegroundColor Cyan
Write-Host "📂 Base Directory: $baseDir" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "Server is running in background. Press Ctrl+C in this terminal to stop." -ForegroundColor Yellow
Write-Host ""

# Request handler loop
while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        
        $ip = $req.RemoteEndPoint.Address.ToString()
        $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
        
        # Configure CORS
        $res.Headers.Add("Access-Control-Allow-Origin", "*")
        $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization")
        
        # Injected Custom Security Headers
        $res.Headers.Add("X-Content-Type-Options", "nosniff")
        $res.Headers.Add("X-Frame-Options", "DENY")
        $res.Headers.Add("X-XSS-Protection", "1; mode=block")
        $res.Headers.Add("Referrer-Policy", "strict-origin-when-cross-origin")
        
        if ($req.HttpMethod -eq "OPTIONS") {
            $res.StatusCode = 200
            $res.Close()
            continue
        }
        
        $path = $req.Url.LocalPath
        $reader = [System.IO.StreamReader]::new($req.InputStream)
        
        # 1. Standard Static Files Routing
        if ($path -eq "/" -or $path -eq "/index.html") {
            $filePath = Join-Path $publicDir "index.html"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "text/html; charset=utf-8"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/style.css") {
            $filePath = Join-Path $publicDir "style.css"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "text/css; charset=utf-8"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/app.js") {
            $filePath = Join-Path $publicDir "app.js"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "application/javascript; charset=utf-8"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/gaming_room_bg.png") {
            $filePath = Join-Path $publicDir "gaming_room_bg.png"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "image/png"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/logo.jpg") {
            $filePath = Join-Path $publicDir "logo.jpg"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "image/jpeg"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/manifest.json") {
            $filePath = Join-Path $publicDir "manifest.json"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "application/json; charset=utf-8"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/service-worker.js") {
            $filePath = Join-Path $publicDir "service-worker.js"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "application/javascript; charset=utf-8"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path -eq "/mallea_portal.cer") {
            $filePath = Join-Path $publicDir "mallea_portal.cer"
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "application/x-x509-ca-cert"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        elseif ($path.StartsWith("/local-apps/")) {
            $filename = $path.Substring(12)
            $filePath = Join-Path $downloadsDir $filename
            if (Test-Path $filePath) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $res.ContentType = "application/octet-stream"
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else { $res.StatusCode = 404 }
        }
        
        # 2. High-Security Authentication APIs
        elseif ($path -eq "/api/auth/login" -and $req.HttpMethod -eq "POST") {
            $body = $reader.ReadToEnd()
            $loginInfo = ConvertFrom-Json $body
            
            # Rate Limiter check
            if ($loginAttempts.ContainsKey($ip)) {
                $attempt = $loginAttempts[$ip]
                if (($now - $attempt.lastAttempt) -lt 600000 -and $attempt.count -ge 5) {
                    $res.StatusCode = 429
                    $res.ContentType = "application/json; charset=utf-8"
                    $msgObj = @{ success = $false; message = "تنبيه أمان: تم حظر محاولات الدخول الزائدة من هذا الجهاز. يرجى الانتظار 10 دقائق." }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $msgObj))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.Close()
                    continue
                }
            }
            
            $db = Load-DB
            $user = $db.users | Where-Object { $_.username.ToLower() -eq $loginInfo.username.ToLower() }
            
            if ($user) {
                $computedHash = Hash-Password $loginInfo.password $user.salt
                if ($computedHash -eq $user.passwordHash) {
                    # Logged in, generate session token (sliding window expiry)
                    $token = [System.Guid]::NewGuid().ToString("N")
                    $activeSessions[$token] = @{
                        username = $user.username
                        expiresAt = $now + 7200000 # 2 hours
                    }
                    
                    # Reset rate limiter
                    $loginAttempts.Remove($ip) | Out-Null
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{
                        success = $true
                        token = $token
                        user = @{
                            username = $user.username
                            email = $user.email
                            webauthnEnabled = ($user.webauthnCredentialId -ne $null)
                        }
                    }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    # Failed attempt
                    if ($loginAttempts.ContainsKey($ip)) {
                        $loginAttempts[$ip].count++
                        $loginAttempts[$ip].lastAttempt = $now
                    } else {
                        $loginAttempts[$ip] = @{ count = 1; lastAttempt = $now }
                    }
                    
                    $res.StatusCode = 401
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "اسم المستخدم أو كلمة المرور غير صحيحة!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } else {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "اسم المستخدم غير مسجل!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
            }
        }
        
        elseif ($path -eq "/api/auth/auto-login-owner" -and $req.HttpMethod -eq "POST") {
            $body = $reader.ReadToEnd()
            $reqData = $null
            if ($body) {
                try { $reqData = ConvertFrom-Json $body } catch {}
            }
            
            $hostHeader = $req.Headers["X-Forwarded-Host"]
            if (!$hostHeader) { $hostHeader = $req.UserHostName }
            $isMalleaHost = $false
            if ($hostHeader) {
                $cleanHost = $hostHeader.Split(":")[0].ToLower()
                if ($cleanHost -eq "mallea" -or $cleanHost -eq "mallea.local" -or $cleanHost -eq "mallea.com") {
                    $isMalleaHost = $true
                }
            }
            
            $isLocalIp = $false
            if ($ip -eq "127.0.0.1" -or $ip -eq "::1" -or $ip.StartsWith("192.168.") -or $ip.StartsWith("10.") -or $ip.StartsWith("fe80:") -or ($ip.StartsWith("172.") -and $ip.Contains("."))) {
                try {
                    $secondOctet = [int]$ip.Split(".")[1]
                    if ($secondOctet -ge 16 -and $secondOctet -le 31) { $isLocalIp = $true }
                } catch {}
                if ($ip -eq "127.0.0.1" -or $ip -eq "::1" -or $ip.StartsWith("192.168.") -or $ip.StartsWith("10.") -or $ip.StartsWith("fe80:")) {
                    $isLocalIp = $true
                }
            }
            
            $allowAutoLogin = $false
            if ($isMalleaHost) {
                $allowAutoLogin = $true
            } elseif ($isLocalIp -and $reqData -and $reqData.owner -eq $true) {
                $allowAutoLogin = $true
            }
            
            if ($allowAutoLogin) {
                $db = Load-DB
                $user = $db.users | Where-Object { $_.username.ToLower() -eq "mallea" }
                
                if ($user) {
                    $token = [System.Guid]::NewGuid().ToString("N")
                    $activeSessions[$token] = @{
                        username = $user.username
                        expiresAt = $now + 7200000 # 2 hours
                    }
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{
                        success = $true
                        token = $token
                        user = @{
                            username = $user.username
                            email = $user.email
                            webauthnEnabled = ($user.webauthnCredentialId -ne $null)
                        }
                    }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $res.StatusCode = 404
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "حساب المدير mallea غير موجود!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } else {
                $res.StatusCode = 403
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: هذا العنوان لا يدعم الدخول التلقائي للمالك!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        
        elseif ($path -eq "/api/auth/register" -and $req.HttpMethod -eq "POST") {
            $body = $reader.ReadToEnd()
            $regInfo = ConvertFrom-Json $body
            
            # Input Sanitization Regex
            $usernameRegex = "^[a-zA-Z0-9_]{3,20}$"
            $emailRegex = "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
            
            if ($null -eq $regInfo.username -or $regInfo.username -notmatch $usernameRegex) {
                $res.StatusCode = 400
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "اسم المستخدم غير صالح! يجب أن يتكون من 3 إلى 20 حرفاً إنجليزياً أو أرقام أو شرطة سفلية فقط." }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            elseif ($null -eq $regInfo.email -or $regInfo.email -notmatch $emailRegex) {
                $res.StatusCode = 400
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "البريد الإلكتروني المدخل غير صالح!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            elseif ($null -eq $regInfo.password -or $regInfo.password.Length -lt 6) {
                $res.StatusCode = 400
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "كلمة المرور يجب أن تتكون من 6 أحرف على الأقل!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            else {
                $db = Load-DB
                $exists = $db.users | Where-Object { $_.username.ToLower() -eq $regInfo.username.ToLower() }
                if ($exists) {
                    $res.StatusCode = 400
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "اسم المستخدم مسجل بالفعل!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    # Create securely
                    $salt = Generate-Salt
                    $hash = Hash-Password $regInfo.password $salt
                    
                    $newUser = @{
                        username = $regInfo.username
                        email = $regInfo.email
                        passwordHash = $hash
                        salt = $salt
                        webauthnCredentialId = $null
                    }
                    
                    # Update users list
                    $usersList = [System.Collections.ArrayList]::new()
                    foreach ($u in $db.users) { $usersList.Add($u) | Out-Null }
                    $usersList.Add($newUser) | Out-Null
                    $db.users = $usersList.ToArray()
                    
                    Save-DB $db
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $true; message = "تم إنشاء الحساب بنجاح! يمكنك الآن تسجيل الدخول." }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            }
        }
        
        # 3. Saves & ROMs APIs (Secured by Token Bearer)
        elseif (($path -eq "/api/saves" -or $path -eq "/api/roms") -and $req.HttpMethod -eq "GET") {
            # Validate Session
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) {
                $token = $authHeader.Substring(7)
            }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة الآمنة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                # Slide session window
                $activeSessions[$token].expiresAt = $now + 7200000
                
                $db = Load-DB
                $res.ContentType = "application/json; charset=utf-8"
                
                if ($path -eq "/api/saves") {
                    $resData = @{ success = $true; data = $db.saves }
                } else {
                    $resData = @{ success = $true; data = $db.roms }
                }
                
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        
        elseif ($path -eq "/api/saves" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
            } else {
                $username = $activeSessions[$token].username
                if ($username -eq "guest") {
                    $res.StatusCode = 403
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "عذراً: الحساب التجريبي محدود الصلاحية! يرجى تسجيل حساب رسمي للاستفادة من كامل المزايا وحفظ البيانات." }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.Close()
                    continue
                }
                $body = $reader.ReadToEnd()
                $saveInfo = ConvertFrom-Json $body
                
                $db = Load-DB
                
                # Delete existing save in same slot
                $savesList = [System.Collections.ArrayList]::new()
                foreach ($s in $db.saves) {
                    if ($s.slot -ne $saveInfo.slot) { $savesList.Add($s) | Out-Null }
                }
                
                $newSave = @{
                    id = "save_" + $now
                    game = $saveInfo.game
                    score = $saveInfo.score
                    slot = $saveInfo.slot
                    date = (Get-Date).ToString("yyyy-MM-dd HH:mm")
                }
                $savesList.Add($newSave) | Out-Null
                $db.saves = $savesList.ToArray()
                
                Save-DB $db
                
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $true; data = $newSave }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        
        elseif ($path.StartsWith("/api/saves/") -and $req.HttpMethod -eq "DELETE") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
            } else {
                $username = $activeSessions[$token].username
                if ($username -eq "guest") {
                    $res.StatusCode = 403
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "عذراً: الحساب التجريبي محدود الصلاحية! يرجى تسجيل حساب رسمي للاستفادة من كامل المزايا وحفظ البيانات." }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.Close()
                    continue
                }
                $slotStr = $path.Substring(11)
                $slot = [int]::Parse($slotStr)
                
                $db = Load-DB
                $savesList = [System.Collections.ArrayList]::new()
                foreach ($s in $db.saves) {
                    if ($s.slot -ne $slot) { $savesList.Add($s) | Out-Null }
                }
                $db.saves = $savesList.ToArray()
                Save-DB $db
                
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $true; message = "Save block deleted successfully" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        
        elseif ($path -eq "/api/saves/import" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
            } else {
                $username = $activeSessions[$token].username
                if ($username -eq "guest") {
                    $res.StatusCode = 403
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "عذراً: الحساب التجريبي محدود الصلاحية! يرجى تسجيل حساب رسمي للاستفادة من كامل المزايا وحفظ البيانات." }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    $res.Close()
                    continue
                }
                
                $body = $reader.ReadToEnd()
                $importData = ConvertFrom-Json $body
                
                if (!$importData -or !$importData.saves) {
                    $res.StatusCode = 400
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "البيانات المرسلة غير صالحة" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $db = Load-DB
                    $savesList = [System.Collections.ArrayList]::new()
                    $savesBySlot = @{}
                    if ($db.saves) {
                        foreach ($s in $db.saves) {
                            $savesBySlot[$s.slot] = $s
                        }
                    }
                    
                    $incomingSaves = @()
                    if ($importData.saves -is [Array]) {
                        $incomingSaves = $importData.saves
                    } elseif ($importData.saves -ne $null) {
                        $incomingSaves = @($importData.saves)
                    }
                    
                    foreach ($incoming in $incomingSaves) {
                        if ($incoming -and $incoming.game -ne $null -and $incoming.score -ne $null -and $incoming.slot -ne $null) {
                            $incomingSlot = [int]$incoming.slot
                            $sDate = (Get-Date).ToString("yyyy-MM-dd HH:mm")
                            if ($incoming.date) { $sDate = $incoming.date }
                            $sId = "save_" + $now + "_" + (Get-Random)
                            if ($incoming.id) { $sId = $incoming.id }
                            
                            $saveObj = @{
                                id = $sId
                                game = $incoming.game
                                score = [int]$incoming.score
                                slot = $incomingSlot
                                date = $sDate
                            }
                            $savesBySlot[$incomingSlot] = $saveObj
                        }
                    }
                    
                    foreach ($key in $savesBySlot.Keys) {
                        $savesList.Add($savesBySlot[$key]) | Out-Null
                    }
                    
                    $db.saves = $savesList.ToArray()
                    Save-DB $db
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $true; data = $db.saves; message = "تم استيراد كروت الذاكرة بنجاح!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            }
        }
        
        # 4. Admin Users Management API (GET)
        elseif ($path -eq "/api/admin/users" -and $req.HttpMethod -eq "GET") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "غير مسموح: هذه اللوحة مخصصة لمدراء النظام فقط!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $db = Load-DB
                    
                    # Safe projection: omit cryptographic hashes and salts!
                    $safeUsers = @()
                    foreach ($u in $db.users) {
                        $safeUsers += @{
                            username = $u.username
                            email = $u.email
                            webauthnEnabled = ($u.webauthnCredentialId -ne $null)
                        }
                    }
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $true; data = $safeUsers }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            }
        }
        
        # 5b. User Update Password API (POST)
        elseif ($path -eq "/api/user/update-password" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $sessionUsername = $activeSessions[$token].username
                if ($sessionUsername -eq "guest") {
                    $res.StatusCode = 403
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "عذراً: الحساب التجريبي محدود الصلاحية ولا يمكنه تغيير كلمة المرور!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $body = $reader.ReadToEnd()
                    $updateInfo = ConvertFrom-Json $body
                    
                    if (!$updateInfo.username -or !$updateInfo.currentPassword -or !$updateInfo.password) {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "خطأ: اسم المستخدم وكلمة المرور الحالية والجديدة إلزامية!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } elseif ($updateInfo.username.ToLower() -ne $sessionUsername.ToLower()) {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "خطأ: اسم المستخدم المدخل لا يطابق المستخدم النشط حالياً!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $db = Load-DB
                        
                        # Find user and verify credentials
                        $verifiedUser = $null
                        foreach ($u in $db.users) {
                            if ($u.username.ToLower() -eq $sessionUsername.ToLower()) {
                                $verifiedUser = $u
                                break
                            }
                        }
                        
                        if ($null -eq $verifiedUser) {
                            $res.StatusCode = 404
                            $res.ContentType = "application/json; charset=utf-8"
                            $resData = @{ success = $false; message = "خطأ: المستخدم غير موجود!" }
                            $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                            $res.OutputStream.Write($bytes, 0, $bytes.Length)
                        } else {
                            $computedCurrentHash = Hash-Password $updateInfo.currentPassword $verifiedUser.salt
                            if ($computedCurrentHash -ne $verifiedUser.passwordHash) {
                                $res.StatusCode = 401
                                $res.ContentType = "application/json; charset=utf-8"
                                $resData = @{ success = $false; message = "خطأ: كلمة المرور الحالية غير صحيحة!" }
                                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                            } else {
                                $newSalt = Generate-Salt
                                $newHash = Hash-Password $updateInfo.password $newSalt
                                $verifiedUser.salt = $newSalt
                                $verifiedUser.passwordHash = $newHash
                                
                                Save-DB $db
                                $res.ContentType = "application/json; charset=utf-8"
                                $resData = @{ success = $true; message = "تم تغيير كلمة المرور بنجاح وحفظها في قاعدة البيانات السحابية!" }
                                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                                $res.OutputStream.Write($bytes, 0, $bytes.Length)
                            }
                        }
                    }
                }
            }
        }

        # 5. Admin Update Settings API (POST)
        elseif ($path -eq "/api/admin/update" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                } else {
                    $body = $reader.ReadToEnd()
                    $updateInfo = ConvertFrom-Json $body
                    
                    $db = Load-DB
                    
                    # Find active admin user
                    $updated = $false
                    foreach ($u in $db.users) {
                        if ($u.username.ToLower() -eq $username.ToLower()) {
                            if ($updateInfo.email) {
                                $u.email = $updateInfo.email
                                $updated = $true
                            }
                            if ($updateInfo.password) {
                                $newSalt = Generate-Salt
                                $newHash = Hash-Password $updateInfo.password $newSalt
                                $u.salt = $newSalt
                                $u.passwordHash = $newHash
                                $updated = $true
                            }
                        }
                    }
                    
                    if ($updated) {
                        Save-DB $db
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $true; message = "تم تحديث البيانات الإدارية بنجاح وحفظها في قاعدة البيانات!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "لم يتم تحديد أي تعديلات!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        }
        
        # 6. Public Portal Configuration API (GET)
        elseif ($path -eq "/api/config" -and $req.HttpMethod -eq "GET") {
            $db = Load-DB
            $res.ContentType = "application/json; charset=utf-8"
            
            # Safe checking
            $portalName = "MGE STATION"
            if ($db.system_config -and $db.system_config.portal_name) {
                $portalName = $db.system_config.portal_name
            }
            
            $resData = @{ success = $true; portal_name = $portalName }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        
        # 7. Admin Update Portal Configuration API (POST)
        elseif ($path -eq "/api/admin/config" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                } else {
                    $body = $reader.ReadToEnd()
                    $configInfo = ConvertFrom-Json $body
                    
                    $db = Load-DB
                    
                    if ($configInfo.portal_name) {
                        $db.system_config.portal_name = $configInfo.portal_name
                        Save-DB $db
                        
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $true; message = "تم تحديث اسم المنصة الإدارية بنجاح!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "اسم المنصة فارغ!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        }
        
        # 7b. Store Games Installation API (POST)
        elseif ($path -eq "/api/store/install" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $body = $reader.ReadToEnd()
                $installInfo = ConvertFrom-Json $body
                
                # Preset game catalogue metadata
                $catalogue = @{
                    "store_game_1" = @{ name = "µCity PSX (لعبة بناء المدن الكلاسيكية الكاملة)"; filename = "ucity_psx.bin"; size = 2516582 }
                    "store_game_2" = @{ name = "PSX Doom Demo (لعبة إطلاق النار ثلاثية الأبعاد الكلاسيكية)"; filename = "psx_doom.bin"; size = 4301289 }
                    "store_game_3" = @{ name = "Super Block Boy (لعبة مغامرات ومنصات ريترو)"; filename = "block_boy.bin"; size = 1887436 }
                    "store_game_4" = @{ name = "Hubble Space Hunter (محاكاة قتال الفضاء ثلاثي الأبعاد)"; filename = "hubble_space.bin"; size = 1258291 }
                    "store_game_5" = @{ name = "Formula Retro GP (لعبة سباق سيارات نيون ريترو كاملة)"; filename = "formula_retro_gp.bin"; size = 3355443 }
                    "store_game_6" = @{ name = "Memory Card formatter (أداة إدارة بطاقات الذاكرة)"; filename = "memcard_tool.bin"; size = 950123 }
                }
                
                if (!$installInfo -or !$installInfo.gameId -or !$catalogue.ContainsKey($installInfo.gameId)) {
                    $res.StatusCode = 400
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "اللعبة غير متوفرة في المتجر!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $game = $catalogue[$installInfo.gameId]
                    
                    # Create simulated bin file if not exists
                    $filePath = Join-Path $uploadsDir $game.filename
                    if (!(Test-Path $filePath)) {
                        Set-Content -Path $filePath -Value ("MGE Simulator ROM Content for " + $game.name)
                    }
                    
                    $db = Load-DB
                    
                    # Check if already installed
                    $alreadyInstalled = $false
                    foreach ($r in $db.roms) {
                        if ($r.filename -eq $game.filename) { $alreadyInstalled = $true }
                    }
                    
                    if ($alreadyInstalled) {
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "هذه اللعبة مضافة بالفعل في مكتبتك السحابية!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        # Add to user's ROMs array
                        $newRom = @{
                            id = "rom_" + $now
                            name = $game.name
                            size = $game.size
                            filename = $game.filename
                            uploadDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                            console = "PS1"
                            preloaded = $false
                        }
                        
                        $romsList = [System.Collections.ArrayList]::new()
                        foreach ($r in $db.roms) { $romsList.Add($r) | Out-Null }
                        $romsList.Add($newRom) | Out-Null
                        $db.roms = $romsList.ToArray()
                        
                        Save-DB $db
                        
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $true; message = "تم تحميل وإضافة لعبة '$($game.name)' لمكتبتك السحابية بنجاح! يمكنك الآن تشغيلها من شاشة المحاكي الرئيسية 🚀" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        }

        # 7c. Add ROM Link API (POST)
        elseif ($path -eq "/api/roms/add-link" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $body = $reader.ReadToEnd()
                $linkInfo = ConvertFrom-Json $body
                
                if (!$linkInfo -or !$linkInfo.name -or !$linkInfo.url) {
                    $res.StatusCode = 400
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "يرجى إدخال اسم اللعبة ورابط التحميل المباشر!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } elseif (!$linkInfo.url.StartsWith("http://") -and !$linkInfo.url.StartsWith("https://")) {
                    $res.StatusCode = 400
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $false; message = "يجب أن يبدأ رابط التحميل بـ http:// أو https://" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $db = Load-DB
                    
                    $newRom = @{
                        id = "rom_" + $now
                        name = $linkInfo.name
                        size = 0
                        filename = $linkInfo.url
                        uploadDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                        console = "PS1"
                        preloaded = $false
                    }
                    
                    $romsList = [System.Collections.ArrayList]::new()
                    foreach ($r in $db.roms) { $romsList.Add($r) | Out-Null }
                    $romsList.Add($newRom) | Out-Null
                    $db.roms = $romsList.ToArray()
                    
                    Save-DB $db
                    
                    $res.ContentType = "application/json; charset=utf-8"
                    $resData = @{ success = $true; message = "تم ربط اللعبة `"$($linkInfo.name)`" بالرابط المباشر بنجاح!" }
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                    $res.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            }
        }

        # 8. Admin Delete User API (POST)
        elseif ($path -eq "/api/admin/users/delete" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                } else {
                    $body = $reader.ReadToEnd()
                    $deleteInfo = ConvertFrom-Json $body
                    
                    if ($deleteInfo.username.ToLower() -eq $username.ToLower()) {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "تنبيه أمان: لا يمكنك حذف حسابك النشط المفتوح حالياً!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $db = Load-DB
                        
                        $usersList = [System.Collections.ArrayList]::new()
                        $deleted = $false
                        foreach ($u in $db.users) {
                            if ($u.username.ToLower() -eq $deleteInfo.username.ToLower()) {
                                $deleted = $true
                            } else {
                                $usersList.Add($u) | Out-Null
                            }
                        }
                        
                        if ($deleted) {
                            $db.users = $usersList.ToArray()
                            Save-DB $db
                            $res.ContentType = "application/json; charset=utf-8"
                            $resData = @{ success = $true; message = "تم حذف الحساب '$($deleteInfo.username)' بنجاح من قاعدة البيانات!" }
                            $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                            $res.OutputStream.Write($bytes, 0, $bytes.Length)
                        } else {
                            $res.StatusCode = 400
                            $res.ContentType = "application/json; charset=utf-8"
                            $resData = @{ success = $false; message = "اسم المستخدم غير مسجل!" }
                            $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                            $res.OutputStream.Write($bytes, 0, $bytes.Length)
                        }
                    }
                }
            }
        }
        
        # 9. Get Local Apps List API (GET)
        elseif ($path -eq "/api/local-apps" -and $req.HttpMethod -eq "GET") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $activeSessions[$token].expiresAt = $now + 7200000
                
                $db = Load-DB
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $true; data = $db.local_apps }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        }
        
        # 10. Admin Add Local App API (POST)
        elseif ($path -eq "/api/admin/local-apps" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                } else {
                    $body = $reader.ReadToEnd()
                    $appInfo = ConvertFrom-Json $body
                    
                    if (!$appInfo.name -or !$appInfo.package) {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "يرجى ملء جميع الحقول المطلوبة!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $db = Load-DB
                        
                        $newApp = @{
                            id = "local_app_" + $now
                            name = $appInfo.name
                            package = $appInfo.package
                            icon = if ($appInfo.icon) { $appInfo.icon } else { "🎮" }
                            platform = if ($appInfo.platform) { $appInfo.platform } else { "Android" }
                        }
                        
                        $appsList = [System.Collections.ArrayList]::new()
                        foreach ($a in $db.local_apps) { $appsList.Add($a) | Out-Null }
                        $appsList.Add($newApp) | Out-Null
                        $db.local_apps = $appsList.ToArray()
                        
                        Save-DB $db
                        
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $true; message = "تم إضافة اللعبة المحلية '$($appInfo.name)' بنجاح وحفظها سحابياً!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        }
        
        # 11. Admin Delete Local App API (POST)
        elseif ($path -eq "/api/admin/local-apps/delete" -and $req.HttpMethod -eq "POST") {
            $authHeader = $req.Headers["Authorization"]
            $token = ""
            if ($authHeader -and $authHeader.StartsWith("Bearer ")) { $token = $authHeader.Substring(7) }
            
            if (!$activeSessions.ContainsKey($token) -or $now -gt $activeSessions[$token].expiresAt) {
                $res.StatusCode = 401
                $res.ContentType = "application/json; charset=utf-8"
                $resData = @{ success = $false; message = "غير مصرح: انتهت صلاحية الجلسة!" }
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $username = $activeSessions[$token].username
                if ($username -ne "admin" -and $username -ne "mamdouh" -and $username -ne "mallea") {
                    $res.StatusCode = 403
                } else {
                    $body = $reader.ReadToEnd()
                    $deleteInfo = ConvertFrom-Json $body
                    
                    $db = Load-DB
                    $appsList = [System.Collections.ArrayList]::new()
                    $deleted = $false
                    foreach ($a in $db.local_apps) {
                        if ($a.id -eq $deleteInfo.id) {
                            $deleted = $true
                        } else {
                            $appsList.Add($a) | Out-Null
                        }
                    }
                    
                    if ($deleted) {
                        $db.local_apps = $appsList.ToArray()
                        Save-DB $db
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $true; message = "تم حذف اللعبة المحلية بنجاح!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    } else {
                        $res.StatusCode = 400
                        $res.ContentType = "application/json; charset=utf-8"
                        $resData = @{ success = $false; message = "معرف اللعبة غير موجود!" }
                        $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $resData))
                        $res.OutputStream.Write($bytes, 0, $bytes.Length)
                    }
                }
            }
        }
        
        # Catch-all
        else {
            if ($res.StatusCode -eq 0) { $res.StatusCode = 404 }
        }
        
    } catch {
        Write-Host "Error in connection handler: $_" -ForegroundColor Red
        if ($res) { $res.StatusCode = 500 }
    }
    
    if ($res) { $res.Close() }
}

if ($proxy) {
    try { $proxy.Stop() } catch {}
}
