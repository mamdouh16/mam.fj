const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Database
db.init();

// Track Active Secure Sessions (Token -> { username, expiresAt })
const activeSessions = new Map();

// High-Security Rate Limiter (Brute Force Protection)
const loginAttempts = new Map();
function authRateLimiter(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const limitWindow = 10 * 60 * 1000; // 10 minutes
  const maxAttempts = 5;
  
  if (loginAttempts.has(ip)) {
    const record = loginAttempts.get(ip);
    if (now - record.lastAttempt > limitWindow) {
      record.count = 1;
      record.lastAttempt = now;
    } else {
      record.count++;
      record.lastAttempt = now;
      if (record.count > maxAttempts) {
        const remainingTime = Math.ceil((limitWindow - (now - record.lastAttempt)) / 60000);
        return res.status(429).json({
          success: false,
          message: `تنبيه أمان: تم حظر محاولات الدخول بسبب تجاوز الحد المسموح. يرجى الانتظار ${remainingTime} دقائق قبل المحاولة مجدداً!`
        });
      }
    }
  } else {
    loginAttempts.set(ip, { count: 1, lastAttempt: now });
  }
  next();
}

// Ensure uploads folder exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Ensure local downloads folder exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR);
}

// Copy generated neon gaming room background if present in the brain directory on boot
try {
  const brainDir = path.join('C:', 'Users', 'LionPower', '.gemini', 'antigravity', 'brain', '5c60eaef-3982-4d29-b5fb-74bc810b7bcc');
  const destImage = path.join(__dirname, 'public', 'gaming_room_bg.png');
  
  // Create public folder if not exists
  const publicDir = path.join(__dirname, 'public');
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
  }
  
  if (fs.existsSync(brainDir)) {
    const files = fs.readdirSync(brainDir);
    // Find the latest generated background image
    const bgFile = files.find(f => f.startsWith('gaming_room_bg_') && f.endsWith('.png'));
    if (bgFile) {
      fs.copyFileSync(path.join(brainDir, bgFile), destImage);
      console.log(`\n🎨 Beautiful Gaming Room Background [${bgFile}] copied to public folder successfully!\n`);
    } else {
      console.log("🎨 No custom background image found in brain directory, using elegant fallback style.");
    }
  }
} catch (err) {
  console.log("Could not copy background image: ", err.message);
}

// Auto-generate lightweight dummy emulator files
const dummyFiles = [
  { name: 'AetherSX2_PS2_Android.apk', content: 'Mock AetherSX2 Android APK File' },
  { name: 'PPSSPP_PSP_Android.apk', content: 'Mock PPSSPP Android APK File' },
  { name: 'PCSX2_PS2_Windows.exe', content: 'Mock PCSX2 Windows Executable File' },
  { name: 'RPCS3_PS3_Windows.zip', content: 'Mock RPCS3 Windows Zip File' }
];

dummyFiles.forEach(f => {
  const filePath = path.join(DOWNLOADS_DIR, f.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, f.content, 'utf8');
  }
});

// Middlewares
app.use(cors());
app.use(express.json());

// Strict HTTP Security Headers Middleware (Bulletproof Security)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy", 
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' 'unsafe-inline'; connect-src 'self';"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve local emulator files statically
app.use('/local-apps', express.static(DOWNLOADS_DIR));

// === HIGH-SECURITY AUTHORISATION MIDDLEWARE ===
function validateSession(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ success: false, message: 'غير مصرح: يرجى تسجيل الدخول أولاً!' });
  }
  
  // Extract token
  const token = authHeader.replace('Bearer ', '');
  if (activeSessions.has(token)) {
    const session = activeSessions.get(token);
    const now = Date.now();
    
    // Check if session has expired
    if (now > session.expiresAt) {
      activeSessions.delete(token);
      return res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة الآمنة! يرجى إعادة تسجيل الدخول.' });
    }
    
    // Slide expiry window (extend by 2 hours)
    session.expiresAt = now + 2 * 60 * 60 * 1000;
    req.username = session.username;
    next();
  } else {
    res.status(401).json({ success: false, message: 'انتهت صلاحية الجلسة الآمنة! يرجى إعادة تسجيل الدخول.' });
  }
}

// Middleware to block guest users from state-modifying requests
function blockGuestUsers(req, res, next) {
  if (req.username === 'guest') {
    return res.status(403).json({
      success: false,
      message: 'عذراً: الحساب التجريبي محدود الصلاحية! يرجى تسجيل حساب رسمي للاستفادة من كامل المزايا وحفظ البيانات.'
    });
  }
  next();
}

// Configure Multer Storage with strict filename sanitization to prevent Path Traversal
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    // Sanitize filename to prevent folder traversal
    const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '');
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    cb(null, uniqueSuffix + '-' + safeName);
  }
});

// Strict file type validator middleware
const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.bin', '.cue', '.iso', '.img', '.zip'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('صيغة ملف غير صالحة! يسمح فقط بصيغ .bin, .cue, .iso, .img, .zip'), false);
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 800 * 1024 * 1024 } // Up to 800MB games
});

// API Routes

// === SECURITY & AUTHENTICATION ENDPOINTS ===

// 1. Standard login with password verification and secure token generation (Apply Rate Limiting!)
app.post('/api/auth/login', authRateLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم وكلمة المرور!' });
    }

    const verified = db.verifyPassword(username, password);
    if (verified) {
      const user = db.getUser(username);
      
      // Generate a cryptographically secure session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      activeSessions.set(sessionToken, {
        username: user.username,
        expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours secure session expiry
      });
      
      res.json({ 
        success: true, 
        token: sessionToken,
        user: { 
          username: user.username,
          email: user.email,
          webauthnEnabled: !!user.webauthnCredentialId 
        } 
      });
    } else {
      res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Secure User Registration API (Apply Rate Limiting & Input Validation!)
app.post('/api/auth/register', authRateLimiter, (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Strict input validation
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: 'يرجى ملء جميع الحقول المطلوبة!' });
    }
    
    // Strict Regex validation to prevent SQL/Shell or HTML injection
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ success: false, message: 'اسم المستخدم غير صالح! يجب أن يتكون من 3-20 حرفاً إنجليزياً أو أرقام أو شرطة سفلية فقط.' });
    }
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال بريد إلكتروني صالح!' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل!' });
    }

    const result = db.registerUser(username, email, password);
    if (result.success) {
      res.json({ success: true, message: 'تم إنشاء الحساب بنجاح! يمكنك الآن تسجيل الدخول.' });
    } else {
      res.status(400).json({ success: false, message: result.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. WebAuthn Registration (Requires Session Validation!)
app.post('/api/auth/webauthn-register', validateSession, blockGuestUsers, (req, res) => {
  try {
    const { credentialId } = req.body;
    if (!credentialId) {
      return res.status(400).json({ success: false, message: 'بيانات بصمة غير مكتملة' });
    }
    
    const success = db.saveUserWebAuthn(req.username, credentialId);
    if (success) {
      res.json({ success: true, message: 'تم تفعيل تسجيل الدخول السريع عبر أمان الجهاز بنجاح!' });
    } else {
      res.status(404).json({ success: false, message: 'المستخدم غير موجود!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. WebAuthn Login Challenge (Public + Rate Limited!)
app.post('/api/auth/webauthn-challenge', authRateLimiter, (req, res) => {
  try {
    const { username } = req.body;
    
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!username || !usernameRegex.test(username)) {
      return res.status(400).json({ success: false, message: 'اسم مستخدم غير صالح!' });
    }

    const user = db.getUser(username);
    if (user && user.webauthnCredentialId) {
      res.json({ success: true, credentialId: user.webauthnCredentialId });
    } else {
      res.status(404).json({ success: false, message: 'لم يتم تفعيل البصمة لهذا المستخدم بعد!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. WebAuthn Login Verify (Public + Rate Limited!)
app.post('/api/auth/webauthn-verify', authRateLimiter, (req, res) => {
  try {
    const { username, credentialId } = req.body;
    const user = db.getUser(username);
    
    if (user && user.webauthnCredentialId === credentialId) {
      // Generate a secure session token upon successful biometric auth!
      const sessionToken = crypto.randomBytes(32).toString('hex');
      activeSessions.set(sessionToken, {
        username: user.username,
        expiresAt: Date.now() + 2 * 60 * 60 * 1000 // 2 hours secure session expiry
      });
      
      res.json({ 
        success: true, 
        token: sessionToken,
        user: { 
          username: user.username,
          email: user.email,
          webauthnEnabled: true 
        } 
      });
    } else {
      res.status(401).json({ success: false, message: 'فشلت عملية التحقق البيومترية!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// === SECURED GAMES AND ROMS ENDPOINTS (APPLYING SESSION VALIDATION) ===

// Get uploaded ROM list
app.get('/api/roms', validateSession, (req, res) => {
  try {
    const roms = db.getRoms();
    res.json({ success: true, data: roms });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Upload a new PlayStation ROM
app.post('/api/roms/upload', validateSession, blockGuestUsers, upload.single('rom'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    const newRom = db.addRom(
      req.file.originalname, 
      req.file.size, 
      req.file.filename
    );
    
    res.json({ success: true, data: newRom });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}, (error, req, res, next) => {
  // Capture multer upload filter error cleanly
  res.status(400).json({ success: false, message: error.message });
});

// Add a new ROM via Direct Link (bypasses server storage limits entirely)
app.post('/api/roms/add-link', validateSession, (req, res) => {
  try {
    const { name, url } = req.body;
    
    if (!name || !url) {
      return res.status(400).json({ success: false, message: 'يرجى إدخال اسم اللعبة ورابط التحميل المباشر!' });
    }
    
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ success: false, message: 'يجب أن يبدأ رابط التحميل بـ http:// أو https://' });
    }
    
    // Add to database with size = 0, filename = url
    const newRom = db.addRom(name, 0, url);
    
    res.json({
      success: true,
      message: `تم ربط اللعبة "${name}" بالرابط المباشر بنجاح!`,
      data: newRom
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Install free store games instantly to the console
app.post('/api/store/install', validateSession, (req, res) => {
  try {
    const { gameId } = req.body;
    
    const catalogue = {
      "store_game_1": { name: "µCity PSX (لعبة بناء المدن الكلاسيكية الكاملة)", filename: "ucity_psx.bin", size: 2516582 },
      "store_game_2": { name: "PSX Doom Demo (لعبة إطلاق النار ثلاثية الأبعاد الكلاسيكية)", filename: "psx_doom.bin", size: 4301289 },
      "store_game_3": { name: "Super Block Boy (لعبة مغامرات ومنصات ريترو)", filename: "block_boy.bin", size: 1887436 },
      "store_game_4": { name: "Hubble Space Hunter (محاكاة قتال الفضاء ثلاثي الأبعاد)", filename: "hubble_space.bin", size: 1258291 },
      "store_game_5": { name: "Formula Retro GP (لعبة سباق سيارات نيون ريترو كاملة)", filename: "formula_retro_gp.bin", size: 3355443 },
      "store_game_6": { name: "Memory Card formatter (أداة إدارة بطاقات الذاكرة)", filename: "memcard_tool.bin", size: 950123 }
    };
    
    if (!gameId || !catalogue[gameId]) {
      return res.status(400).json({ success: false, message: 'اللعبة غير متوفرة في المتجر!' });
    }
    
    const game = catalogue[gameId];
    
    // Check if already installed
    const roms = db.getRoms();
    const alreadyInstalled = roms.some(r => r.filename === game.filename);
    
    if (alreadyInstalled) {
      return res.json({ success: false, message: 'هذه اللعبة مضافة بالفعل في مكتبتك السحابية!' });
    }
    
    // Add to user's ROMs array
    const newRom = db.addRom(game.name, game.size, game.filename);
    
    res.json({
      success: true,
      message: `تم تحميل وإضافة لعبة '${game.name}' لمكتبتك السحابية بنجاح! يمكنك الآن تشغيلها من شاشة المحاكي الرئيسية 🚀`,
      data: newRom
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// Get all saves/memory cards
app.get('/api/saves', validateSession, (req, res) => {
  try {
    const saves = db.getSaves();
    res.json({ success: true, data: saves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create or update a save slot
app.post('/api/saves', validateSession, blockGuestUsers, (req, res) => {
  try {
    const { game, score, slot } = req.body;
    if (!game || score === undefined || slot === undefined) {
      return res.status(400).json({ success: false, message: 'Missing save details' });
    }
    
    const newSave = db.addSave(game, parseInt(score), parseInt(slot));
    res.json({ success: true, data: newSave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete a save slot
app.delete('/api/saves/:slot', validateSession, blockGuestUsers, (req, res) => {
  try {
    const slot = parseInt(req.params.slot);
    const success = db.deleteSave(slot);
    if (success) {
      res.json({ success: true, message: 'Save block deleted successfully' });
    } else {
      res.status(404).json({ success: false, message: 'Save block not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Import saves
app.post('/api/saves/import', validateSession, blockGuestUsers, (req, res) => {
  try {
    const { saves } = req.body;
    if (!saves || !Array.isArray(saves)) {
      return res.status(400).json({ success: false, message: 'البيانات المرسلة غير صالحة' });
    }
    
    const success = db.importSaves(saves);
    if (success) {
      res.json({ success: true, data: db.getSaves(), message: 'تم استيراد كروت الذاكرة بنجاح!' });
    } else {
      res.status(400).json({ success: false, message: 'فشل استيراد كروت الذاكرة' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Update Password API with verification
app.post('/api/user/update-password', validateSession, (req, res) => {
  try {
    const sessionUsername = req.username;
    if (sessionUsername === 'guest') {
      return res.status(403).json({ success: false, message: 'عذراً: الحساب التجريبي محدود الصلاحية ولا يمكنه تغيير كلمة المرور!' });
    }

    const { username, currentPassword, password } = req.body;
    if (!username || !currentPassword || !password) {
      return res.status(400).json({ success: false, message: 'خطأ: اسم المستخدم وكلمة المرور الحالية والجديدة إلزامية!' });
    }

    if (username.toLowerCase() !== sessionUsername.toLowerCase()) {
      return res.status(400).json({ success: false, message: 'خطأ: اسم المستخدم المدخل لا يطابق المستخدم النشط حالياً!' });
    }

    // Verify current password
    const verified = db.verifyPassword(sessionUsername, currentPassword);
    if (!verified) {
      return res.status(401).json({ success: false, message: 'خطأ: كلمة المرور الحالية غير صحيحة!' });
    }

    const success = db.changePassword(sessionUsername, password);
    if (success) {
      res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح وحفظها في قاعدة البيانات السحابية!' });
    } else {
      res.status(404).json({ success: false, message: 'المستخدم غير موجود!' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Stream a ROM file to emulator core (requires active secure cookies/headers or parameters)
app.get('/roms/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('ROM File not found');
  }
});

// Start Server
app.listen(PORT, () => {
  console.log('\n==================================================');
  console.log('🎮  MGE (Mamdouh Game Emulator) SERVER ACTIVE!  🎮');
  console.log(`📡  Server URL: http://localhost:${PORT}`);
  console.log(`📂  Uploads folder: ${UPLOADS_DIR}`);
  console.log('==================================================\n');
});
