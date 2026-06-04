/**
 * RetroPlay PSX Emulator Hub & Server-DB Simulator Core
 * Written in Pure ES6 Vanilla Javascript
 */

// Global App State
let isPowerOn = false;
let activeTab = 'emulator';
let crtEnabled = true;
let consoleTheme = 'midnight';
let controllerSkin = 'classic';
let selectedBootSound = 'ps1';
let volumeLevel = 0.8;
let bootTimeout1 = null;
let bootTimeout2 = null;

// BGM, Rumble, and Sequencer State
let bgmEnabled = false;
let rumbleEnabled = true;
let bgmIntervalId = null;
let bgmStep = 0;
const MELODY = [
  261.63, 329.63, 392.00, 523.25, 392.00, 329.63, 261.63, 329.63,
  293.66, 349.23, 440.00, 587.33, 440.00, 349.23, 293.66, 349.23,
  329.63, 392.00, 493.88, 659.25, 493.88, 392.00, 329.63, 392.00,
  349.23, 440.00, 523.25, 698.46, 523.25, 440.00, 349.23, 440.00
];
const BASS = [
  130.81, 130.81, 130.81, 130.81,
  146.83, 146.83, 146.83, 146.83,
  164.81, 164.81, 164.81, 164.81,
  174.61, 174.61, 174.61, 174.61
];

// Security/Auth State
let isAuthenticated = false;
let registeredBiometricId = null;
window.termsOpened = false;

// Virtual Controller State
let keysPressed = {};

// Game State & Canvas Variables
let canvas = null;
let ctx = null;
let gameLoopId = null;

// Emulator Screen Mode: 'off', 'boot', 'bios_menu', 'playing_game'
let screenMode = 'off';
let selectedGameIndex = 0;

let gameState = {
  activeGame: 'space_racer', // 'space_racer' or 'highway_racer'
  score: 0,
  highScore: 0,
  speed: 2,
  playerX: 0,
  playerY: 0,
  bullets: [],
  obstacles: [],
  particles: [],
  distance: 0,
  gameOver: false,
  playing: false,
  
  // Driving game extra states
  roadCurve: 0,
  opponentCars: [],
  roadZ: 0
};

// Web Audio API Synthesizer Context
let audioCtx = null;

// Loaded Server Data
let serverSavesList = [];
let serverRomsList = [];

// Initialize when DOM loads
document.addEventListener('DOMContentLoaded', () => {
  // Register PWA Service Worker for offline capability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => console.log('ServiceWorker registered successfully: ', reg.scope))
      .catch(err => console.error('ServiceWorker registration failed: ', err));
  }

  // Unlocking AudioContext on first user interaction for iOS/Android compliance
  const unlockAudio = () => {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } catch (e) {
      console.log("Audio unlock failed: ", e);
    }
    // Remove listeners once unlocked
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('click', unlockAudio);
  document.addEventListener('touchstart', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  canvas = document.getElementById('emulator-canvas');
  ctx = canvas.getContext('2d');
  
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Check if WebAuthn biometrics are enabled on this machine
  checkBiometricsEnabled();

  // Load custom portal config dynamically
  fetchPortalConfig();

  // Volume range listener
  document.getElementById('volume-range').addEventListener('input', (e) => {
    volumeLevel = parseFloat(e.target.value) / 100;
  });

  // Check if session token exists from a previous session
  const storedToken = localStorage.getItem('mge_session_token');
  
  // Auto-login owner if visiting via mallea domains, local IPs, or if query param ?owner=true is present
  const currentHost = window.location.hostname;
  const urlParams = new URLSearchParams(window.location.search);
  const isOwnerQuery = urlParams.get('owner') === 'true' || urlParams.get('admin') === 'mallea';
  
  const isLocalIpHost = currentHost === 'localhost' || 
                        currentHost === '127.0.0.1' || 
                        currentHost === '::1' ||
                        currentHost.startsWith('10.') || 
                        currentHost.startsWith('192.168.') || 
                        currentHost.startsWith('172.');
                        
  const logoutIntent = localStorage.getItem('mge_logout_intent') === 'true';
  const shouldAutoLogin = isOwnerQuery || 
                          ((isLocalIpHost || currentHost === 'mallea' || currentHost === 'mallea.local' || currentHost === 'mallea.com') && !logoutIntent);
  
  if (!storedToken && shouldAutoLogin) {
    fetch('/api/auth/auto-login-owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: true })
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        localStorage.setItem('mge_session_token', resData.token);
        localStorage.setItem('mge_username', resData.user.username);
        localStorage.removeItem('mge_logout_intent');
        // Clean URL to remove the query parameters from the address bar before reload
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
        window.location.reload();
      }
    })
    .catch(err => console.log('Auto-login owner failed: ', err));
  }

  if (storedToken) {
    fetch('/api/saves', {
      headers: { 'Authorization': `Bearer ${storedToken}` }
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        isAuthenticated = true;
        document.getElementById('auth-layer').classList.remove('active');
        serverSavesList = resData.data;
        
        let maxScore = 0;
        serverSavesList.forEach(s => {
          if (s.score > maxScore) maxScore = s.score;
        });
        gameState.highScore = maxScore;
        updateMemoryCardUI();
        
        // Apply limitations based on username
        const storedUsername = localStorage.getItem('mge_username');
        applyGuestLimitations(storedUsername);
        updateProfileUI();

        // Fetch ROMs too
        fetchRomsFromServer();
        
        // Fetch local apps too
        fetchLocalApps();
      } else {
        // Expired/invalid session
        localStorage.removeItem('mge_session_token');
      }
    })
    .catch(err => {
      console.log("Could not auto-login: ", err);
    });
  }

  // Setup Virtual Controller Button Event Handlers for Mouse/Touch
  setupVirtualController();

  // Setup Physical Keyboard Listeners
  setupKeyboardController();

  // Initialize Gamepad Polling
  requestAnimationFrame(pollGamepad);

  // Setup Terms & Conditions Event Listeners dynamically (avoiding inline HTML onclick issues)
  const regTermsCheckbox = document.getElementById('reg-terms');
  const regTermsLabel = document.getElementById('label-reg-terms');
  const regTermsLink = document.getElementById('link-reg-terms');

  if (regTermsCheckbox) {
    regTermsCheckbox.addEventListener('click', (e) => {
      if (!window.termsOpened) {
        e.preventDefault();
        showTermsModal();
      }
    });
  }

  if (regTermsLabel) {
    regTermsLabel.addEventListener('click', (e) => {
      // Don't trigger if the actual <a> link inside was clicked (let the link's listener handle it)
      if (e.target.tagName === 'A') return;
      
      if (!window.termsOpened) {
        showTermsModal();
      } else {
        if (regTermsCheckbox) {
          regTermsCheckbox.checked = !regTermsCheckbox.checked;
          regTermsCheckbox.dispatchEvent(new Event('change'));
        }
      }
    });
  }

  if (regTermsLink) {
    regTermsLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTermsModal();
    });
  }

  // Initialize device-specific enhancements
  initDeviceAdaptation();
});

// Resize retro canvas
function resizeCanvas() {
  if (canvas) {
    canvas.width = 640;
    canvas.height = 480;
  }
}

// -------------------------------------------------------------
// SECURE BIO-LOGIN & SYSTEM AUTHENTICATION (NEW FEATURES)
// -------------------------------------------------------------

// Toggle between Login and Register cards beautifully
function toggleAuthForm(mode) {
  const loginCard = document.getElementById('mge-login-card');
  const registerCard = document.getElementById('mge-register-card');
  const resetCard = document.getElementById('mge-reset-card');
  
  if (mode === 'register') {
    loginCard.style.display = 'none';
    registerCard.style.display = 'flex';
    if (resetCard) resetCard.style.display = 'none';
  } else if (mode === 'reset') {
    loginCard.style.display = 'none';
    registerCard.style.display = 'none';
    if (resetCard) resetCard.style.display = 'flex';
  } else {
    loginCard.style.display = 'flex';
    registerCard.style.display = 'none';
    if (resetCard) resetCard.style.display = 'none';
  }
  
  // Play subtle sound feedback
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(600, 0.05);
}

// Toggle password input visibility (switching type between 'password' and 'text')
function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
    btn.setAttribute('title', 'إخفاء كلمة المرور');
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
    btn.setAttribute('title', 'إظهار كلمة المرور');
  }
  
  // Play subtle feedback beep
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(500, 0.04);
}

// Submit Password Reset Request to Server API (no session required, verifies username and email)
function submitPasswordReset() {
  const usernameVal = document.getElementById('reset-username').value.trim();
  const emailVal = document.getElementById('reset-email').value.trim();
  const passwordVal = document.getElementById('reset-password').value;
  const confirmVal = document.getElementById('reset-password-confirm').value;

  if (!usernameVal || !emailVal || !passwordVal || !confirmVal) {
    alert("⚠️ يرجى ملء جميع الحقول المطلوبة!");
    return;
  }

  // Basic regex validation
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!usernameRegex.test(usernameVal)) {
    alert("⚠️ اسم المستخدم غير صالح! يجب أن يتكون من 3-20 حرفاً إنجليزياً أو أرقام أو شرطة سفلية فقط.");
    return;
  }
  if (!emailRegex.test(emailVal)) {
    alert("⚠️ يرجى إدخال بريد إلكتروني صالح!");
    return;
  }
  if (passwordVal.length < 6) {
    alert("⚠️ كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل!");
    return;
  }
  if (passwordVal !== confirmVal) {
    alert("⚠️ كلمات المرور غير متطابقة!");
    return;
  }

  // Play submit sound
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(400, 0.1, 'sine');

  fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: usernameVal,
      email: emailVal,
      newPassword: passwordVal
    })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      // Clear fields
      document.getElementById('reset-username').value = '';
      document.getElementById('reset-email').value = '';
      document.getElementById('reset-password').value = '';
      document.getElementById('reset-password-confirm').value = '';
      // Switch back to login form
      toggleAuthForm('login');
    } else {
      alert("⚠️ " + resData.message);
    }
  })
  .catch(err => {
    console.error("Password reset failed:", err);
    alert("⚠️ حدث خطأ أثناء التواصل مع السيرفر.");
  });
}

// Submit secure User Registration to Server API
function submitRegistration() {
  const usernameVal = document.getElementById('reg-username').value.trim();
  const emailVal = document.getElementById('reg-email').value.trim();
  const passwordVal = document.getElementById('reg-password').value;
  const confirmVal = document.getElementById('reg-password-confirm').value;
  const termsCheckbox = document.getElementById('reg-terms');

  // Input validation
  if (!usernameVal || !emailVal || !passwordVal || !confirmVal) {
    alert("⚠️ يرجى ملء جميع الحقول المطلوبة!");
    return;
  }

  // Alphanumeric username check
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(usernameVal)) {
    alert("⚠️ اسم المستخدم غير صالح! يجب أن يتكون من 3 إلى 20 حرفاً إنجليزياً أو أرقام أو شرطة سفلية فقط (بدون مسافات أو رموز خاصة).");
    return;
  }

  // Email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailVal)) {
    alert("⚠️ البريد الإلكتروني غير صالح! يرجى إدخال بريد إلكتروني صحيح.");
    return;
  }

  // Password strength check
  if (passwordVal.length < 6) {
    alert("⚠️ كلمة المرور ضعيفة! يجب أن تتكون من 6 أحرف على الأقل.");
    return;
  }

  if (passwordVal !== confirmVal) {
    alert("⚠️ كلمتا المرور غير متطابقتين!");
    return;
  }

  if (!termsCheckbox || !termsCheckbox.checked) {
    alert("⚠️ يرجى الموافقة على الشروط والأحكام لإكمال إنشاء الحساب!");
    return;
  }

  fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: usernameVal,
      email: emailVal,
      password: passwordVal
    })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      
      // Cleanup registration fields on success
      document.getElementById('reg-username').value = '';
      document.getElementById('reg-email').value = '';
      document.getElementById('reg-password').value = '';
      document.getElementById('reg-password-confirm').value = '';
      if (termsCheckbox) {
        termsCheckbox.checked = false;
      }
      window.termsOpened = false;

      // Auto-toggle to login form
      toggleAuthForm('login');
      // Autofill registered username for easier experience
      document.getElementById('login-username').value = usernameVal;
      document.getElementById('login-password').value = '';
    } else {
      alert("⚠️ فشل التسجيل: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Registration failed: ", err);
    alert("تعذر الاتصال بالخادم لإنشاء الحساب!");
  });
}

// Middleware/UI check to apply limitations on Guest/Trial accounts
function applyGuestLimitations(username) {
  // Remove existing banner if any
  const existingBanner = document.getElementById('guest-warning-banner');
  if (existingBanner) existingBanner.remove();

  if (username === 'guest') {
    // 1. Create a beautiful neon orange warning banner at the top of the page!
    const banner = document.createElement('div');
    banner.id = 'guest-warning-banner';
    banner.style.cssText = `
      width: 100%;
      background: linear-gradient(90deg, #ffc02e, #ff5e97);
      color: #050608;
      text-align: center;
      padding: 0.6rem;
      font-size: 0.82rem;
      font-weight: 700;
      box-shadow: 0 0 15px rgba(255, 192, 46, 0.4);
      z-index: 1000;
      position: sticky;
      top: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 1rem;
      font-family: 'Inter', sans-serif;
    `;
    banner.innerHTML = `
      <span>⚠️ وضع الدخول التجريبي: المزايا محدودة (لا يمكن الرفع أو مسح بطاقة الذاكرة). يرجى تسجيل حساب رسمي للحصول على الصلاحيات الكاملة!</span>
      <button onclick="localStorage.removeItem('mge_session_token'); localStorage.removeItem('mge_username'); location.reload();" style="
        background: #050608; 
        color: #ffc02e; 
        border: none; 
        padding: 0.25rem 0.75rem; 
        border-radius: 8px; 
        font-weight: 800; 
        cursor: pointer;
        font-size: 0.7rem;
      ">سجل حساباً رسمياً 🔑</button>
    `;
    document.body.prepend(banner);

    // 2. Hide WebAuthn quick biometric registration button in settings
    const bioSettingsBtn = document.getElementById('btn-register-biometric');
    if (bioSettingsBtn) {
      bioSettingsBtn.style.display = 'none';
      const settingItem = bioSettingsBtn.closest('.setting-item');
      if (settingItem) settingItem.style.display = 'none';
    }

    // 3. Prevent ROM Upload interaction
    const uploaderBox = document.querySelector('.uploader-box');
    if (uploaderBox) {
      uploaderBox.style.opacity = '0.5';
      uploaderBox.style.cursor = 'not-allowed';
      uploaderBox.onclick = (e) => {
        e.stopPropagation();
        alert("⚠️ عذراً: رفع ملفات الألعاب (ROMs) الخاصة بك مخصص للحسابات الرسمية فقط لضمان خصوصيتك وحماية مساحتك السحابية. يرجى إنشاء حساب رسمي!");
      };
    }
  } else {
    // Official user, ensure everything is clean and active
    const bioSettingsBtn = document.getElementById('btn-register-biometric');
    if (bioSettingsBtn) {
      bioSettingsBtn.style.display = 'block';
      const settingItem = bioSettingsBtn.closest('.setting-item');
      if (settingItem) settingItem.style.display = 'flex';
    }
    
    // Restore default upload handler
    const uploaderBox = document.querySelector('.uploader-box');
    if (uploaderBox) {
      uploaderBox.style.opacity = '1';
      uploaderBox.style.cursor = 'pointer';
      uploaderBox.onclick = () => { triggerRomUpload(); };
    }
  }
}

// Submit standard Username / Password Login
function submitPasswordLogin() {
  const userField = document.getElementById('login-username').value.trim();
  const passField = document.getElementById('login-password').value;
  
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: userField, password: passField })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      // Success! Authenticate user
      isAuthenticated = true;
      localStorage.setItem('mge_session_token', resData.token);
      localStorage.setItem('mge_username', resData.user.username);
      localStorage.setItem('mge_email', resData.user.email);
      localStorage.removeItem('mge_logout_intent');
      document.getElementById('auth-layer').classList.remove('active');
      
      // Beep sound
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      playBeepSound(880, 0.15, 'sine');

      // Apply Guest UI / Restrictions
      applyGuestLimitations(resData.user.username);
      updateProfileUI();

      // Load user data immediately upon login
      fetchSavesFromServer();
      fetchRomsFromServer();

      // Prompt to register biometrics for future quick logins
      if (!resData.user.webauthnEnabled) {
        setTimeout(() => {
          if (confirm("🔒 هل ترغب في تفعيل تسجيل الدخول السريع والآمن باستخدام أمان جهازك (بصمة الإصبع أو رمز PIN للويندوز) للمرة القادمة؟")) {
            registerBiometrics();
          }
        }, 1000);
      }
    } else {
      alert("⚠️ فشل الدخول: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Login failed: ", err);
    alert("تعذر الاتصال بالخادم لتسجيل الدخول!");
  });
}

// Submit guest/trial login automatically without typing credentials
function submitGuestTrialLogin() {
  // Fill credentials in inputs visually so the user sees it happening!
  document.getElementById('login-username').value = 'guest';
  document.getElementById('login-password').value = 'guest';
  
  // Play a beep sound
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(700, 0.1);
  
  // Auto submit standard login
  submitPasswordLogin();
}

// Register device biometrics using HTML5 WebAuthn API
function registerBiometrics() {
  if (!window.PublicKeyCredential) {
    alert("متصفحك الحالي أو جهازك لا يدعم خاصية أمان الويب البيومترية!");
    return;
  }

  const activeUser = localStorage.getItem('mge_username') || 'admin';

  // Create registration challenge
  const challenge = new Uint8Array(32);
  window.crypto.getRandomValues(challenge);
  
  const createCredentialOptions = {
    publicKey: {
      challenge: challenge,
      rp: { name: "RetroPlay PSX Hub" },
      user: {
        id: new Uint8Array([1, 2, 3, 4]),
        name: activeUser,
        displayName: `RetroPlay ${activeUser}`
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }  // RS256
      ],
      authenticatorSelection: {
        userVerification: "required",
        residentKey: "preferred"
      },
      timeout: 60000
    }
  };

  navigator.credentials.create(createCredentialOptions)
    .then(newCredential => {
      // Base64 encode raw credential ID
      const credentialId = btoa(String.fromCharCode.apply(null, new Uint8Array(newCredential.rawId)));
      
      const token = localStorage.getItem('mge_session_token');
      // Save key to local database server
      return fetch('/api/auth/webauthn-register', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ username: activeUser, credentialId })
      });
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        alert("🔒 تم تفعيل الدخول البيومتري بنجاح! يمكنك الآن الدخول بلمسة واحدة أو رمز PIN!");
        document.getElementById('btn-biometric-login').style.display = 'block';
        localStorage.setItem('retroplay_bio_enabled', 'true');
      } else {
        alert("فشل ربط البصمة: " + resData.message);
      }
    })
    .catch(err => {
      console.error("Biometric registration cancelled/failed: ", err);
    });
}

// Biometric Quick Login (Windows Hello PIN/Fingerprint verification)
function submitBiometricLogin() {
  const lastUser = localStorage.getItem('mge_username') || 'admin';
  
  fetch('/api/auth/webauthn-challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: lastUser })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      const storedCredId = resData.credentialId;
      
      // Call browser Authenticator prompt
      const challenge = new Uint8Array(32);
      window.crypto.getRandomValues(challenge);
      
      // Decode credential id back to raw array
      const rawId = new Uint8Array(atob(storedCredId).split("").map(c => c.charCodeAt(0)));
      
      const getCredentialOptions = {
        publicKey: {
          challenge: challenge,
          allowCredentials: [{
            id: rawId,
            type: "public-key"
          }],
          userVerification: "required",
          timeout: 60000
        }
      };
      
      return navigator.credentials.get(getCredentialOptions)
        .then(assertion => {
          // Verify authentication against database record
          return fetch('/api/auth/webauthn-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: lastUser, credentialId: storedCredId })
          });
        });
    } else {
      alert("فشل تحدي البصمة: " + resData.message);
    }
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      isAuthenticated = true;
      localStorage.setItem('mge_session_token', resData.token);
      localStorage.setItem('mge_username', resData.user.username);
      localStorage.setItem('mge_email', resData.user.email);
      localStorage.removeItem('mge_logout_intent');
      document.getElementById('auth-layer').classList.remove('active');
      
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      playBeepSound(880, 0.15, 'sine');

      // Apply Guest UI / Restrictions
      applyGuestLimitations(resData.user.username);
      updateProfileUI();

      // Load user data immediately upon login
      fetchSavesFromServer();
      fetchRomsFromServer();
    } else {
      alert("فشل التحقق البيومتري!");
    }
  })
  .catch(err => {
    console.error("Biometric login cancelled/failed: ", err);
  });
}

// Check local storage on launch to render quick biometric button
function checkBiometricsEnabled() {
  const bioLocal = localStorage.getItem('retroplay_bio_enabled');
  if (bioLocal === 'true') {
    document.getElementById('btn-biometric-login').style.display = 'block';
  }
}

// -------------------------------------------------------------
// Database Fetch Connectors (APIs)
// -------------------------------------------------------------
function fetchSavesFromServer() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  fetch('/api/saves', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        serverSavesList = resData.data;
        
        let maxScore = 0;
        serverSavesList.forEach(s => {
          if (s.score > maxScore) maxScore = s.score;
        });
        gameState.highScore = maxScore;
        
        updateMemoryCardUI();
      }
    })
    .catch(err => {
      console.error("Failed to load saves: ", err);
      updateMemoryCardUI();
    });
}

function fetchRomsFromServer() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  fetch('/api/roms', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        serverRomsList = resData.data;
        updateRomsLibraryUI();
        
        if (screenMode === 'bios_menu') {
          drawBiosMenu();
        }
      }
    })
    .catch(err => console.error("Failed to fetch server roms: ", err));
}

// -------------------------------------------------------------
// Web Audio API: Dynamic PS1, PS2, PSP, PS3 Boot Sound Synthesizers
// -------------------------------------------------------------
function playStartupSound() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    const masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(volumeLevel, now + 0.3);
    masterGain.connect(audioCtx.destination);

    if (selectedBootSound === 'ps1') {
      const lowFreqs = [32.70, 48.99, 65.41, 97.99]; // C1, G1, C2, G2
      
      lowFreqs.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();
        
        osc.type = idx % 2 === 0 ? 'sawtooth' : 'sine';
        osc.frequency.setValueAtTime(freq, now);
        osc.detune.setValueAtTime((idx - 1.5) * 8, now);
        
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(150, now);
        filter.frequency.exponentialRampToValueAtTime(600, now + 4.0);
        filter.Q.setValueAtTime(1, now);

        oscGain.gain.setValueAtTime(0, now);
        oscGain.gain.linearRampToValueAtTime(0.25, now + 1.8);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 8.5);

        osc.connect(filter);
        filter.connect(oscGain);
        oscGain.connect(masterGain);
        
        osc.start(now);
        osc.stop(now + 9.0);
      });

      setTimeout(() => {
        if (!isPowerOn) return;
        const chimeNow = audioCtx.currentTime;
        const highFreqs = [880, 1100, 1320, 1760];
        
        highFreqs.forEach((freq, idx) => {
          const osc = audioCtx.createOscillator();
          const oscGain = audioCtx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, chimeNow);
          osc.frequency.exponentialRampToValueAtTime(freq * 1.5, chimeNow + 3.0);
          
          oscGain.gain.setValueAtTime(0, chimeNow);
          oscGain.gain.linearRampToValueAtTime(0.12, chimeNow + 0.5);
          oscGain.gain.exponentialRampToValueAtTime(0.001, chimeNow + 4.0);
          
          osc.connect(oscGain);
          oscGain.connect(masterGain);
          osc.start(chimeNow);
          osc.stop(chimeNow + 4.5);
        });
      }, 3800);

    } else if (selectedBootSound === 'ps2') {
      const lowOsc = audioCtx.createOscillator();
      const lowGain = audioCtx.createGain();
      lowOsc.type = 'sine';
      lowOsc.frequency.setValueAtTime(55.0, now); // A1
      lowOsc.frequency.linearRampToValueAtTime(41.2, now + 6.0); // E1
      
      lowGain.gain.setValueAtTime(0, now);
      lowGain.gain.linearRampToValueAtTime(0.6, now + 1.5);
      lowGain.gain.exponentialRampToValueAtTime(0.001, now + 9.0);
      
      lowOsc.connect(lowGain);
      lowGain.connect(masterGain);
      lowOsc.start(now);
      lowOsc.stop(now + 9.2);

      const bufferSize = audioCtx.sampleRate * 6;
      const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noiseSource = audioCtx.createBufferSource();
      noiseSource.buffer = buffer;
      
      const bandpass = audioCtx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.setValueAtTime(100, now);
      bandpass.frequency.exponentialRampToValueAtTime(1200, now + 4.0);
      bandpass.frequency.exponentialRampToValueAtTime(150, now + 8.0);
      bandpass.Q.setValueAtTime(4.0, now);
      
      const noiseGain = audioCtx.createGain();
      noiseGain.gain.setValueAtTime(0, now);
      noiseGain.gain.linearRampToValueAtTime(0.18, now + 2.0);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 8.5);
      
      noiseSource.connect(bandpass);
      bandpass.connect(noiseGain);
      noiseGain.connect(masterGain);
      noiseSource.start(now);
      noiseSource.stop(now + 9.0);

      const chimeFreqs = [261.63, 329.63, 392.00, 523.25];
      chimeFreqs.forEach(freq => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + 2.0);
        oscGain.gain.setValueAtTime(0, now + 2.0);
        oscGain.gain.linearRampToValueAtTime(0.1, now + 3.0);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 8.0);
        
        osc.connect(oscGain);
        oscGain.connect(masterGain);
        osc.start(now + 2.0);
        osc.stop(now + 8.5);
      });

    } else if (selectedBootSound === 'psp') {
      const chord = [220.00, 277.18, 329.63, 440.00, 554.37];
      chord.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();
        osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(freq, now);
        
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        lfo.frequency.value = 5.0;
        lfoGain.gain.value = 4;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.detune);
        lfo.start(now);
        
        oscGain.gain.setValueAtTime(0, now);
        oscGain.gain.linearRampToValueAtTime(0.15, now + 0.8);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 6.0);
        
        osc.connect(oscGain);
        oscGain.connect(masterGain);
        osc.start(now);
        osc.stop(now + 6.5);
      });

    } else if (selectedBootSound === 'ps3') {
      const chord = [130.81, 196.00, 261.63, 329.63, 392.00, 523.25];
      chord.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        osc.detune.setValueAtTime((Math.random() - 0.5) * 12, now);

        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(100, now);
        filter.frequency.exponentialRampToValueAtTime(1500, now + 3.0);
        
        oscGain.gain.setValueAtTime(0, now);
        oscGain.gain.linearRampToValueAtTime(0.12, now + 2.0);
        oscGain.gain.exponentialRampToValueAtTime(0.001, now + 8.5);
        
        osc.connect(filter);
        filter.connect(oscGain);
        oscGain.connect(masterGain);
        osc.start(now);
        osc.stop(now + 9.0);
      });
    }

  } catch (err) {
    console.error("Boot sound synthesis failed: ", err);
  }
}

function playBeepSound(freq = 440, duration = 0.08, type = 'sine') {
  if (!isPowerOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    
    gain.gain.setValueAtTime(volumeLevel * 0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {}
}

// -------------------------------------------------------------
// Power Controls & Boot Sequence Management
// -------------------------------------------------------------
function togglePower() {
  const powerLed = document.getElementById('power-led');
  const powerStatusLabel = document.getElementById('power-status-label');
  const standbyLayer = document.getElementById('standby-layer');
  const bootSony = document.getElementById('boot-sony');
  const bootPs = document.getElementById('boot-ps');
  const gameLayer = document.getElementById('game-layer');
  
  if (!isPowerOn) {
    isPowerOn = true;
    powerLed.classList.add('active');
    powerStatusLabel.innerText = "ON";
    powerStatusLabel.style.color = "#00ff66";
    
    standbyLayer.style.opacity = '0';
    setTimeout(() => { standbyLayer.style.display = 'none'; }, 400);

    playStartupSound();

    bootSony.classList.add('active');
    screenMode = 'boot';
    
    if (bgmEnabled) {
      startBgmSequencer();
    }
    
    bootTimeout1 = setTimeout(() => {
      bootSony.classList.remove('active');
      bootPs.classList.add('active');
      if (navigator.vibrate) navigator.vibrate([150, 100, 150]);
    }, 4200);

    bootTimeout2 = setTimeout(() => {
      bootPs.classList.remove('active');
      gameLayer.classList.add('active');
      document.getElementById('screen-glare').classList.add('active');
      enterBiosMenu();
    }, 9200);

  } else {
    isPowerOn = false;
    powerLed.classList.remove('active');
    powerStatusLabel.innerText = "OFF";
    powerStatusLabel.style.color = "";
    
    clearTimeout(bootTimeout1);
    clearTimeout(bootTimeout2);
    
    stopGame();
    stopBgmSequencer();
    screenMode = 'off';

    standbyLayer.style.display = 'flex';
    setTimeout(() => { standbyLayer.style.opacity = '1'; }, 50);

    bootSony.classList.remove('active');
    bootPs.classList.remove('active');
    gameLayer.classList.remove('active');
    document.getElementById('screen-glare').classList.remove('active');
  }
}

// -------------------------------------------------------------
// Customisation Theme & Skins Selector
// -------------------------------------------------------------
function switchTab(tabName) {
  activeTab = tabName;
  document.getElementById('btn-tab-emulator').classList.toggle('active', tabName === 'emulator');
  document.getElementById('btn-tab-downloads').classList.toggle('active', tabName === 'downloads');
  document.getElementById('btn-tab-profile').classList.toggle('active', tabName === 'profile');
  document.getElementById('btn-tab-ai').classList.toggle('active', tabName === 'ai');
  
  document.getElementById('tab-emulator').classList.toggle('active', tabName === 'emulator');
  document.getElementById('tab-downloads').classList.toggle('active', tabName === 'downloads');
  document.getElementById('tab-profile').classList.toggle('active', tabName === 'profile');
  document.getElementById('tab-ai').classList.toggle('active', tabName === 'ai');
  
  playBeepSound(400, 0.05);
}

function changeTheme(themeName) {
  document.body.className = '';
  document.body.classList.add(`theme-${themeName}`);
  
  const buttons = document.querySelectorAll('#theme-selector .selector-option');
  buttons.forEach(btn => btn.classList.remove('active'));
  
  const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick').includes(themeName));
  if (activeBtn) activeBtn.classList.add('active');
  playBeepSound(500, 0.06);
}

function changeSkin(skinName) {
  controllerSkin = skinName;
  const shell = document.getElementById('console-shell');
  shell.classList.remove('skin-classic', 'skin-neon', 'skin-wood', 'skin-crystal');
  shell.classList.add(`skin-${skinName}`);
  
  const buttons = document.querySelectorAll('#skin-selector .selector-option');
  buttons.forEach(btn => btn.classList.remove('active'));
  const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick').includes(skinName));
  if (activeBtn) activeBtn.classList.add('active');
  
  playBeepSound(skinName === 'neon' ? 880 : (skinName === 'wood' ? 220 : 440), 0.12, 'triangle');
}

function changeBootSound(soundKey) {
  selectedBootSound = soundKey;
  const buttons = document.querySelectorAll('#bootsound-selector .selector-option');
  buttons.forEach(btn => btn.classList.remove('active'));
  const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick').includes(soundKey));
  if (activeBtn) activeBtn.classList.add('active');
  
  const tones = { ps1: 440, ps2: 330, psp: 554, ps3: 659 };
  playBeepSound(tones[soundKey] || 440, 0.2, 'sine');
}

function toggleCRT(enable) {
  crtEnabled = enable;
  document.getElementById('crt-shader').classList.toggle('active', enable);
  const buttons = document.querySelectorAll('#crt-selector .selector-option');
  buttons[0].classList.toggle('active', enable);
  buttons[1].classList.toggle('active', !enable);
  playBeepSound(500, 0.06);
}

// -------------------------------------------------------------
// 6 Premium Features: BGM, Rumble, Save States Import/Export
// -------------------------------------------------------------
function toggleBGM(enable) {
  bgmEnabled = enable;
  const buttons = document.querySelectorAll('#bgm-selector .selector-option');
  buttons.forEach(btn => btn.classList.remove('active'));
  const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick').includes(enable.toString()));
  if (activeBtn) activeBtn.classList.add('active');
  
  if (enable) {
    if (isPowerOn) {
      startBgmSequencer();
    }
  } else {
    stopBgmSequencer();
  }
  playBeepSound(400, 0.05);
}

function startBgmSequencer() {
  stopBgmSequencer();
  if (!bgmEnabled) return;
  
  bgmStep = 0;
  bgmIntervalId = setInterval(() => {
    playBgmStep();
  }, 150);
}

function stopBgmSequencer() {
  if (bgmIntervalId) {
    clearInterval(bgmIntervalId);
    bgmIntervalId = null;
  }
}

function playBgmStep() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    return;
  }
  
  const melodyFreq = MELODY[bgmStep % MELODY.length];
  const bassFreq = BASS[Math.floor(bgmStep / 4) % BASS.length];
  const now = audioCtx.currentTime;
  
  if (melodyFreq > 0) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(melodyFreq, now);
    const baseVolume = 0.04 * volumeLevel;
    gain.gain.setValueAtTime(baseVolume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  }
  
  if (bgmStep % 2 === 0 && bassFreq > 0) {
    const oscB = audioCtx.createOscillator();
    const gainB = audioCtx.createGain();
    oscB.type = 'triangle';
    oscB.frequency.setValueAtTime(bassFreq, now);
    const bassVolume = 0.06 * volumeLevel;
    gainB.gain.setValueAtTime(bassVolume, now);
    gainB.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
    oscB.connect(gainB);
    gainB.connect(audioCtx.destination);
    oscB.start(now);
    oscB.stop(now + 0.29);
  }
  
  bgmStep++;
}

function toggleRumble(enable) {
  rumbleEnabled = enable;
  const buttons = document.querySelectorAll('#rumble-selector .selector-option');
  buttons.forEach(btn => btn.classList.remove('active'));
  const activeBtn = Array.from(buttons).find(b => b.getAttribute('onclick').includes(enable.toString()));
  if (activeBtn) activeBtn.classList.add('active');
  playBeepSound(600, 0.08);
  if (enable) {
    triggerGamepadRumble(0.8, 0.8, 200);
  }
}

function triggerGamepadRumble(strong, weak, duration) {
  if (!rumbleEnabled) return;
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = gamepads[0];
  if (gp && gp.vibrationActuator) {
    try {
      gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: duration || 200,
        weakMagnitude: weak || 0.5,
        strongMagnitude: strong || 0.5
      });
    } catch (e) {
      console.log('Gamepad rumble failed: ', e);
    }
  }
  if (navigator.vibrate) {
    try {
      navigator.vibrate(duration || 200);
    } catch (e) {}
  }
}

function exportSaves() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) {
    alert('⚠️ يرجى تسجيل الدخول أولاً لتصدير كروت التخزين!');
    return;
  }
  
  fetch('/api/saves', {
    headers: { 'Authorization': Bearer  }
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      const dataStr = JSON.stringify({ saves: resData.data }, null, 2);
      const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
      const linkElement = document.createElement('a');
      linkElement.setAttribute('href', dataUri);
      linkElement.setAttribute('download', 'saves_backup.json');
      linkElement.click();
      alert('🎉 تم تصدير كروت التخزين بنجاح!');
      playBeepSound(880, 0.15);
    } else {
      alert('⚠️ فشل تصدير كروت التخزين: ' + resData.message);
    }
  })
  .catch(err => {
    console.error(err);
    alert('⚠️ حدث خطأ أثناء تصدير كروت التخزين');
  });
}

// Global quick helper function for triggering input
function triggerImportSaves() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) {
    alert('⚠️ يرجى تسجيل الدخول أولاً لاستيراد كروت التخزين!');
    return;
  }
  document.getElementById('import-saves-file').click();
}

function handleImportSaves(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !data.saves || !Array.isArray(data.saves)) {
        alert('⚠️ صيغة الملف غير صحيحة! يجب أن يحتوي على مصفوفة saves.');
        return;
      }
      
      const token = localStorage.getItem('mge_session_token');
      fetch('/api/saves/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': Bearer 
        },
        body: JSON.stringify({ saves: data.saves })
      })
      .then(res => {
        if (res.status === 403) {
          alert("⚠️ عذراً: الحساب التجريبي محدود الصلاحية! يرجى تسجيل حساب رسمي للاستفادة من كامل المزايا وحفظ البيانات.");
          throw new Error('Forbidden');
        }
        return res.json();
      })
      .then(resData => {
        if (resData.success) {
          alert('🎉 تم استيراد كروت الذاكرة بنجاح!');
          serverSavesList = resData.data;
          
          let maxScore = 0;
          serverSavesList.forEach(s => {
            if (s.score > maxScore) maxScore = s.score;
          });
          gameState.highScore = maxScore;
          updateMemoryCardUI();
          playBeepSound(880, 0.2, 'triangle');
        } else {
          alert('⚠️ فشل الاستيراد: ' + resData.message);
        }
      })
      .catch(err => {
        if (err.message !== 'Forbidden') {
          console.error(err);
          alert('⚠️ حدث خطأ أثناء الاتصال بالخادم لاستيراد كروت التخزين!');
        }
      });
    } catch (err) {
      alert('⚠️ فشل قراءة الملف! تأكد أنه ملف JSON صالح.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// -------------------------------------------------------------
// Sound Synthesis Helpers for Games
// -------------------------------------------------------------
function playShootSound() {
  if (!isPowerOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.15);
    
    gain.gain.setValueAtTime(volumeLevel * 0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}

function playExplosionSound() {
  if (!isPowerOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(40, audioCtx.currentTime + 0.4);
    
    gain.gain.setValueAtTime(volumeLevel * 0.25, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  } catch (e) {}
}

function playPowerUpSound() {
  if (!isPowerOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    
    osc.frequency.setValueAtTime(330, now);
    osc.frequency.setValueAtTime(440, now + 0.08);
    osc.frequency.setValueAtTime(554, now + 0.16);
    osc.frequency.setValueAtTime(659, now + 0.24);
    osc.frequency.setValueAtTime(880, now + 0.32);
    
    gain.gain.setValueAtTime(volumeLevel * 0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(now + 0.45);
  } catch (e) {}
}

function playScreechSound() {
  if (!isPowerOn) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(800 + Math.random() * 200, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(700, audioCtx.currentTime + 0.15);
    
    gain.gain.setValueAtTime(volumeLevel * 0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.15);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}

// -------------------------------------------------------------
// BIOS System Dashboard: Selection Menu
// -------------------------------------------------------------
function enterBiosMenu() {
  screenMode = 'bios_menu';
  selectedGameIndex = 0;
  stopGame();
  drawBiosMenu();
}

function drawBiosMenu() {
  if (screenMode !== 'bios_menu' || !ctx) return;
  
  ctx.fillStyle = '#051026';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 30, canvas.width, 80);
  ctx.strokeStyle = 'rgba(0,240,255,0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 30); ctx.lineTo(canvas.width, 30); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 110); ctx.lineTo(canvas.width, 110); ctx.stroke();

  ctx.font = "bold 20px 'Orbitron', sans-serif";
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.shadowBlur = 10; ctx.shadowColor = '#00f0ff';
  ctx.fillText("PLAYSTATION SYSTEM BIOS", canvas.width / 2, 65);
  ctx.font = "10px 'Press Start 2P', monospace";
  ctx.fillStyle = 'var(--accent-color)';
  ctx.shadowColor = 'var(--accent-color)';
  ctx.fillText("SELECT RETRO GAME TO EXECUTE", canvas.width / 2, 95);
  ctx.shadowBlur = 0;

  const combinedGames = [...serverRomsList];
  
  ctx.textAlign = 'left';
  if (combinedGames.length === 0) {
    ctx.font = "12px 'Press Start 2P', monospace";
    ctx.fillStyle = '#ff5252';
    ctx.fillText("NO GAMES PRESENT. UPLOAD ROM IN SETTINGS!", 60, canvas.height / 2);
  } else {
    const startY = 160;
    const spacing = 45;
    
    combinedGames.forEach((game, index) => {
      const isSelected = index === selectedGameIndex;
      const y = startY + index * spacing;
      
      if (isSelected) {
        ctx.fillStyle = 'rgba(0, 240, 255, 0.15)';
        ctx.fillRect(40, y - 12, canvas.width - 80, spacing - 10);
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 1;
        ctx.strokeRect(40, y - 12, canvas.width - 80, spacing - 10);
        
        ctx.fillStyle = '#00e676';
        ctx.font = "12px 'Press Start 2P', monospace";
        ctx.fillText("▶", 55, y + 12);
        
        const animFrame = Math.floor(Date.now() / 150) % 4;
        const cdSymbols = ["💿", "📀", "💿", "📀"];
        ctx.font = "14px 'Press Start 2P', monospace";
        ctx.fillText(cdSymbols[animFrame], 75, y + 14);

        ctx.fillStyle = '#fff';
        ctx.font = "bold 13px 'Orbitron', sans-serif";
        ctx.fillText(game.name.substring(0, 48), 105, y + 14);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.font = "13px 'Orbitron', sans-serif";
        ctx.fillText("💿", 75, y + 14);
        ctx.fillText(game.name.substring(0, 48), 105, y + 14);
      }
    });
  }

  ctx.fillStyle = 'rgba(255,255,255,0.02)';
  ctx.fillRect(0, canvas.height - 50, canvas.width, 50);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, canvas.height - 50); ctx.lineTo(canvas.width, canvas.height - 50); ctx.stroke();

  ctx.font = "9px 'Press Start 2P', monospace";
  ctx.fillStyle = '#8e95a5';
  ctx.textAlign = 'center';
  ctx.fillText("UP/DOWN: SCROLL | START / CROSS: BOOT GAME", canvas.width / 2, canvas.height - 20);
  ctx.textAlign = 'left';
}

function handleBiosNavigation(direction) {
  if (screenMode !== 'bios_menu') return;
  
  const combinedGames = [...serverRomsList];
  if (combinedGames.length === 0) return;
  
  if (direction === 'up') {
    selectedGameIndex = (selectedGameIndex - 1 + combinedGames.length) % combinedGames.length;
    playBeepSound(400, 0.05);
  } else if (direction === 'down') {
    selectedGameIndex = (selectedGameIndex + 1) % combinedGames.length;
    playBeepSound(400, 0.05);
  }
  
  drawBiosMenu();
}

function bootSelectedGame() {
  if (screenMode !== 'bios_menu') return;
  
  const combinedGames = [...serverRomsList];
  if (combinedGames.length === 0) return;
  
  const targetGame = combinedGames[selectedGameIndex];
  
  screenMode = 'boot';
  playBeepSound(770, 0.15, 'square');
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "14px 'Press Start 2P', monospace";
  ctx.fillStyle = '#00e676';
  ctx.textAlign = 'center';
  ctx.fillText("BOOTING RETRO CD SYSTEM...", canvas.width/2, canvas.height/2 - 20);
  ctx.fillStyle = '#fff';
  ctx.fillText(targetGame.name.substring(0, 28), canvas.width/2, canvas.height/2 + 10);
  ctx.textAlign = 'left';

  setTimeout(() => {
    screenMode = 'playing_game';
    
    if (targetGame.id === 'rom_pre1') {
      gameState.activeGame = 'space_racer';
      startGame();
    } else if (targetGame.id === 'rom_pre2') {
      gameState.activeGame = 'highway_racer';
      startHighwayGame();
    } else {
      gameState.activeGame = 'space_racer';
      startGame();
    }
  }, 3000);
}

// -------------------------------------------------------------
// D-PAD & Action controller mappings
// -------------------------------------------------------------
function setupVirtualController() {
  const buttons = document.querySelectorAll('[data-btn]');
  
  buttons.forEach(button => {
    const handlePressStart = (e) => {
      e.preventDefault();
      if (!isPowerOn) return;
      
      const btnKey = button.getAttribute('data-btn');
      keysPressed[btnKey] = true;
      button.classList.add('pressed');
      
      if (navigator.vibrate) navigator.vibrate(35);
      
      if (screenMode === 'bios_menu') {
        if (btnKey === 'up') handleBiosNavigation('up');
        if (btnKey === 'down') handleBiosNavigation('down');
        if (btnKey === 'cross' || btnKey === 'start') bootSelectedGame();
        return;
      }
      
      playBeepSound(btnKey === 'start' || btnKey === 'select' ? 330 : 660, 0.06);
      
      if (btnKey === 'start' && gameState.gameOver) {
        if (gameState.activeGame === 'space_racer') restartGame();
        else if (gameState.activeGame === 'highway_racer') restartHighwayGame();
      }
      
      if (btnKey === 'select' && screenMode === 'playing_game') {
        enterBiosMenu();
      }
    };
    
    const handlePressEnd = (e) => {
      e.preventDefault();
      const btnKey = button.getAttribute('data-btn');
      keysPressed[btnKey] = false;
      button.classList.remove('pressed');
    };

    button.addEventListener('touchstart', handlePressStart, { passive: false });
    button.addEventListener('touchend', handlePressEnd, { passive: false });
    button.addEventListener('mousedown', handlePressStart);
    button.addEventListener('mouseup', handlePressEnd);
    button.addEventListener('mouseleave', handlePressEnd);
  });
}

function setupKeyboardController() {
  const keyMap = {
    'ArrowUp': 'up',
    'w': 'up',
    'ArrowDown': 'down',
    's': 'down',
    'ArrowLeft': 'left',
    'a': 'left',
    'ArrowRight': 'right',
    'd': 'right',
    'z': 'cross',
    'x': 'circle',
    'c': 'square',
    'v': 'triangle',
    'q': 'L1',
    'e': 'R1',
    ' ': 'select',
    'Enter': 'start'
  };

  document.addEventListener('keydown', (e) => {
    if (!isPowerOn) return;
    const mappedBtn = keyMap[e.key];
    if (mappedBtn) {
      e.preventDefault();
      keysPressed[mappedBtn] = true;
      const element = document.querySelector(`[data-btn="${mappedBtn}"]`);
      if (element) element.classList.add('pressed');
      
      if (screenMode === 'bios_menu') {
        if (mappedBtn === 'up') handleBiosNavigation('up');
        if (mappedBtn === 'down') handleBiosNavigation('down');
        if (mappedBtn === 'cross' || mappedBtn === 'start') bootSelectedGame();
        return;
      }
      
      if (mappedBtn === 'start' && gameState.gameOver) {
        if (gameState.activeGame === 'space_racer') restartGame();
        else if (gameState.activeGame === 'highway_racer') restartHighwayGame();
      }
      
      if (mappedBtn === 'select' && screenMode === 'playing_game') {
        enterBiosMenu();
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    const mappedBtn = keyMap[e.key];
    if (mappedBtn) {
      keysPressed[mappedBtn] = false;
      const element = document.querySelector(`[data-btn="${mappedBtn}"]`);
      if (element) element.classList.remove('pressed');
    }
  });
}

function pollGamepad() {
  if (isPowerOn) {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[0];
    
    if (gp) {
      const prevUp = keysPressed['up'];
      const prevDown = keysPressed['down'];
      const prevCross = keysPressed['cross'];
      const prevStart = keysPressed['start'];

      keysPressed['up'] = gp.axes[1] < -0.3 || gp.buttons[12].pressed;
      keysPressed['down'] = gp.axes[1] > 0.3 || gp.buttons[13].pressed;
      keysPressed['left'] = gp.axes[0] < -0.3 || gp.buttons[14].pressed;
      keysPressed['right'] = gp.axes[0] > 0.3 || gp.buttons[15].pressed;
      
      keysPressed['cross'] = gp.buttons[0].pressed;
      keysPressed['circle'] = gp.buttons[1].pressed;
      keysPressed['square'] = gp.buttons[2].pressed;
      keysPressed['triangle'] = gp.buttons[3].pressed;
      
      keysPressed['select'] = gp.buttons[8].pressed;
      keysPressed['start'] = gp.buttons[9].pressed;
      
      keysPressed['L1'] = gp.buttons[4].pressed;
      keysPressed['R1'] = gp.buttons[5].pressed;
      
      const buttons = document.querySelectorAll('[data-btn]');
      buttons.forEach(btn => {
        const val = btn.getAttribute('data-btn');
        if (keysPressed[val]) btn.classList.add('pressed');
        else btn.classList.remove('pressed');
      });

      if (screenMode === 'bios_menu') {
        if (keysPressed['up'] && !prevUp) handleBiosNavigation('up');
        if (keysPressed['down'] && !prevDown) handleBiosNavigation('down');
        if ((keysPressed['cross'] && !prevCross) || (keysPressed['start'] && !prevStart)) bootSelectedGame();
        return;
      }
      
      if (keysPressed['start'] && gameState.gameOver) {
        if (gameState.activeGame === 'space_racer') restartGame();
        else if (gameState.activeGame === 'highway_racer') restartHighwayGame();
      }
      if (keysPressed['select'] && screenMode === 'playing_game') {
        enterBiosMenu();
      }
    }
  }
  requestAnimationFrame(pollGamepad);
}

// -------------------------------------------------------------
// GAME 1: GALAXY STRIKER 1999 (Space Racer)
// -------------------------------------------------------------
function startGame() {
  gameState.playing = true;
  gameState.gameOver = false;
  gameState.score = 0;
  gameState.speed = 4;
  gameState.playerX = canvas.width / 2;
  gameState.playerY = canvas.height - 100;
  gameState.bullets = [];
  gameState.obstacles = [];
  gameState.particles = [];
  gameState.distance = 0;
  
  // Power-up additions
  gameState.powerUps = [];
  gameState.doubleLaser = false;
  gameState.powerUpTimer = 0;
  gameState.frameCount = 0;
  gameState.lastShotFrame = 0;

  runGameLoop();
}

function stopGame() {
  gameState.playing = false;
  cancelAnimationFrame(gameLoopId);
}

function restartGame() {
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  startGame();
}

function runGameLoop() {
  if (!gameState.playing) return;
  
  if (gameState.activeGame === 'space_racer') {
    updateGameLogic();
    drawGameGraphics();
  } else if (gameState.activeGame === 'highway_racer') {
    updateHighwayLogic();
    drawHighwayGraphics();
  }
  
  gameLoopId = requestAnimationFrame(runGameLoop);
}

function updateGameLogic() {
  if (gameState.gameOver) return;

  if (keysPressed['left']) gameState.playerX -= 6;
  if (keysPressed['right']) gameState.playerX += 6;
  if (keysPressed['up']) gameState.speed = Math.min(8, gameState.speed + 0.1);
  else if (keysPressed['down']) gameState.speed = Math.max(2, gameState.speed - 0.1);
  else gameState.speed = Math.max(4, gameState.speed - 0.05);

  if (keysPressed['L1']) gameState.playerX -= 12;
  if (keysPressed['R1']) gameState.playerX += 12;

  if (gameState.playerX < 60) gameState.playerX = 60;
  if (gameState.playerX > canvas.width - 60) gameState.playerX = canvas.width - 60;

  gameState.distance += gameState.speed * 0.1;
  gameState.score = Math.floor(gameState.distance * 10);

  // Powerup timer countdown
  if (gameState.powerUpTimer > 0) {
    gameState.powerUpTimer--;
  } else {
    gameState.doubleLaser = false;
  }

  // Shooting with frame cooldown
  if (!gameState.frameCount) gameState.frameCount = 0;
  gameState.frameCount++;

  if (keysPressed['circle']) {
    if (!gameState.lastShotFrame) gameState.lastShotFrame = 0;
    if (gameState.frameCount - gameState.lastShotFrame > 8) {
      gameState.lastShotFrame = gameState.frameCount;
      playShootSound();
      
      if (gameState.doubleLaser) {
        gameState.bullets.push({
          x: gameState.playerX - 12,
          y: gameState.playerY - 20,
          vy: -12
        });
        gameState.bullets.push({
          x: gameState.playerX + 12,
          y: gameState.playerY - 20,
          vy: -12
        });
      } else {
        gameState.bullets.push({
          x: gameState.playerX,
          y: gameState.playerY - 20,
          vy: -12
        });
      }
    }
  }

  // Create obstacles with horizontal movement
  if (Math.random() < 0.04) {
    const isMoving = Math.random() < 0.4; // 40% move horizontally
    gameState.obstacles.push({
      x: Math.random() * (canvas.width - 120) + 60,
      y: -40,
      size: Math.random() * 20 + 15,
      speed: Math.random() * 2 + gameState.speed,
      type: Math.random() < 0.3 ? 'drone' : 'asteroid',
      vx: isMoving ? (Math.random() > 0.5 ? 2 : -2) : 0
    });
  }

  gameState.bullets.forEach((b, i) => {
    b.y += b.vy;
    if (b.y < 0) gameState.bullets.splice(i, 1);
  });

  // Powerups movement and collision
  if (!gameState.powerUps) gameState.powerUps = [];
  gameState.powerUps.forEach((p, index) => {
    p.y += p.vy;
    
    // Player collision
    const dx = p.x - gameState.playerX;
    const dy = p.y - gameState.playerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < p.size + 15) {
      gameState.doubleLaser = true;
      gameState.powerUpTimer = 350; // 350 frames of double laser
      gameState.powerUps.splice(index, 1);
      playPowerUpSound();
      triggerGamepadRumble(0.5, 0.9, 150);
    } else if (p.y > canvas.height + 20) {
      gameState.powerUps.splice(index, 1);
    }
  });

  gameState.obstacles.forEach((o, index) => {
    o.y += o.speed;
    if (o.vx) {
      o.x += o.vx;
      if (o.x < 50 || o.x > canvas.width - 50) {
        o.vx = -o.vx;
      }
    }
    
    const dx = o.x - gameState.playerX;
    const dy = o.y - gameState.playerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < o.size + 15) {
      gameState.gameOver = true;
      playExplosionSound();
      triggerGamepadRumble(0.9, 0.9, 400);
      if (navigator.vibrate) navigator.vibrate([300, 100, 500]);
      
      if (gameState.score > gameState.highScore) {
        gameState.highScore = gameState.score;
        saveScoreToServer('Galaxy Striker', gameState.score);
      }
    }

    gameState.bullets.forEach((b, bi) => {
      const bdx = o.x - b.x;
      const bdy = o.y - b.y;
      const bdist = Math.sqrt(bdx * bdx + bdy * bdy);
      
      if (bdist < o.size + 6) {
        createParticles(o.x, o.y);
        
        // Spawn power-up drop
        if (Math.random() < 0.25) { // 25% chance
          gameState.powerUps.push({
            x: o.x,
            y: o.y,
            vy: 2,
            size: 10
          });
        }
        
        gameState.obstacles.splice(index, 1);
        gameState.bullets.splice(bi, 1);
        gameState.distance += 5;
        playExplosionSound();
        triggerGamepadRumble(0.3, 0.6, 120);
      }
    });

    if (o.y > canvas.height + 50) gameState.obstacles.splice(index, 1);
  });

  gameState.particles.forEach((p, i) => {
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= 0.03;
    if (p.alpha <= 0) gameState.particles.splice(i, 1);
  });
}

function drawGameGraphics() {
  ctx.fillStyle = '#06070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(0, 240, 255, 0.1)';
  ctx.lineWidth = 1;
  const gridCount = 20;
  const offset = (gameState.distance * 10) % 40;
  
  for (let i = 0; i < gridCount; i++) {
    const startX = (canvas.width / 2) + (i - gridCount / 2) * 50;
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 80);
    ctx.lineTo((i - gridCount / 2) * 200 + canvas.width / 2, canvas.height);
    ctx.stroke();
  }

  for (let y = 80; y < canvas.height; y += 30) {
    const adjustedY = y + offset;
    if (adjustedY > canvas.height) continue;
    ctx.beginPath();
    ctx.moveTo(0, adjustedY);
    ctx.lineTo(canvas.width, adjustedY);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  for (let i = 0; i < 15; i++) {
    const starX = (Math.sin(i + gameState.distance * 0.05) * 0.5 + 0.5) * canvas.width;
    const starY = ((i * 35 + gameState.distance * 3) % canvas.height);
    ctx.fillRect(starX, starY, 2, 2);
  }

  gameState.obstacles.forEach(o => {
    ctx.beginPath();
    if (o.type === 'drone') {
      ctx.strokeStyle = '#e040fb';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#e040fb';
      ctx.strokeRect(o.x - o.size/2, o.y - o.size/2, o.size, o.size);
    } else {
      ctx.strokeStyle = '#ff5e97';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#ff5e97';
      ctx.arc(o.x, o.y, o.size, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  });

  // Draw powerups
  if (gameState.powerUps) {
    gameState.powerUps.forEach(p => {
      ctx.beginPath();
      ctx.strokeStyle = '#00ff66';
      ctx.fillStyle = 'rgba(0, 255, 102, 0.2)';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#00ff66';
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      
      ctx.fillStyle = '#00ff66';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('L', p.x, p.y);
    });
  }

  gameState.bullets.forEach(b => {
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x, b.y - 12);
    ctx.stroke();
  });

  gameState.particles.forEach(p => {
    ctx.fillStyle = p.color;
    ctx.globalAlpha = p.alpha;
    ctx.fillRect(p.x, p.y, 4, 4);
  });
  ctx.globalAlpha = 1;

  ctx.shadowBlur = 15;
  ctx.shadowColor = '#00f0ff';
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(gameState.playerX, gameState.playerY - 20);
  ctx.lineTo(gameState.playerX - 25, gameState.playerY + 15);
  ctx.lineTo(gameState.playerX - 8, gameState.playerY + 5);
  ctx.lineTo(gameState.playerX + 8, gameState.playerY + 5);
  ctx.lineTo(gameState.playerX + 25, gameState.playerY + 15);
  ctx.closePath();
  ctx.stroke();
  
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#ff5e97';
  ctx.strokeStyle = '#ff5e97';
  ctx.beginPath();
  ctx.moveTo(gameState.playerX - 8, gameState.playerY + 5);
  ctx.lineTo(gameState.playerX, gameState.playerY + 15 + Math.random() * 10);
  ctx.lineTo(gameState.playerX + 8, gameState.playerY + 5);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.font = "12px 'Press Start 2P', monospace";
  ctx.fillStyle = '#fff';
  ctx.fillText(`SCORE: ${gameState.score}`, 20, 40);
  ctx.fillStyle = '#00e676';
  ctx.fillText(`SPEED: ${Math.floor(gameState.speed * 30)}KM/H`, 20, 65);
  
  ctx.fillStyle = '#ff5e97';
  ctx.fillText(`HI-SCORE: ${gameState.highScore}`, canvas.width - 240, 40);

  ctx.fillStyle = '#8e95a5';
  ctx.fillText("SELECT: RETURN TO MENU", 20, canvas.height - 20);

  if (gameState.gameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "24px 'Press Start 2P', monospace";
    ctx.fillStyle = '#ff5252';
    ctx.textAlign = 'center';
    ctx.fillText("GAME OVER", canvas.width / 2, canvas.height / 2 - 40);

    ctx.font = "12px 'Press Start 2P', monospace";
    ctx.fillStyle = '#fff';
    ctx.fillText(`FINAL SCORE: ${gameState.score}`, canvas.width / 2, canvas.height / 2 + 10);
    ctx.fillStyle = '#a4c639';
    ctx.fillText("PRESS 'START' TO PLAY AGAIN", canvas.width / 2, canvas.height / 2 + 50);
    
    ctx.fillStyle = '#8e95a5';
    ctx.fillText("PRESS 'SELECT' FOR MAIN MENU", canvas.width / 2, canvas.height / 2 + 90);
    ctx.textAlign = 'left';
  }
}// -------------------------------------------------------------
// GAME 2: FORMULA RETRO RACING (Pseudo-3D Highway Racer)
// -------------------------------------------------------------
function startHighwayGame() {
  gameState.playing = true;
  gameState.gameOver = false;
  gameState.score = 0;
  gameState.speed = 3;
  gameState.playerX = 0;
  gameState.playerY = canvas.height - 120;
  gameState.distance = 0;
  gameState.roadCurve = 0;
  gameState.roadZ = 0;
  gameState.opponentCars = [
    { z: 100, x: -0.4, speed: 2, color: '#e040fb' },
    { z: 220, x: 0.3, speed: 1.5, color: '#ffc02e' },
    { z: 350, x: -0.2, speed: 2.5, color: '#00ff66' }
  ];
  gameState.particles = [];

  runGameLoop();
}

function restartHighwayGame() {
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  startHighwayGame();
}

function updateHighwayLogic() {
  if (gameState.gameOver) return;

  if (keysPressed['left']) gameState.playerX -= 0.04;
  if (keysPressed['right']) gameState.playerX += 0.04;
  
  if (keysPressed['up'] || keysPressed['triangle']) {
    gameState.speed = Math.min(10, gameState.speed + 0.15);
  } else if (keysPressed['down'] || keysPressed['cross']) {
    gameState.speed = Math.max(0, gameState.speed - 0.2);
  } else {
    gameState.speed = Math.max(3, gameState.speed - 0.05);
  }

  // Screeching sound & rumble logic during sharp turns at high speed
  if ((keysPressed['left'] || keysPressed['right']) && gameState.speed > 5) {
    if (Math.random() < 0.15) {
      playScreechSound();
      triggerGamepadRumble(0.2, 0.5, 80);
    }
  }

  if (gameState.playerX < -1.4) gameState.playerX = -1.4;
  if (gameState.playerX > 1.4) gameState.playerX = 1.4;

  gameState.roadZ += gameState.speed * 2;
  gameState.roadCurve = Math.sin(gameState.roadZ * 0.0005) * 1.5;

  gameState.distance += gameState.speed * 0.1;
  gameState.score = Math.floor(gameState.distance * 10);

  gameState.opponentCars.forEach(car => {
    car.z -= gameState.speed - car.speed;
    
    if (car.z < 0) {
      car.z = 400 + Math.random() * 200;
      car.x = (Math.random() - 0.5) * 1.6;
      car.speed = 1.5 + Math.random() * 3;
    }

    if (car.z < 15 && car.z > 2) {
      const roadDiff = Math.abs(car.x - gameState.playerX);
      if (roadDiff < 0.35) {
        gameState.gameOver = true;
        playExplosionSound();
        triggerGamepadRumble(0.9, 0.9, 500);
        if (navigator.vibrate) navigator.vibrate([300, 100, 500]);
        
        if (gameState.score > gameState.highScore) {
          gameState.highScore = gameState.score;
          saveScoreToServer('Formula Retro Racing', gameState.score);
        }
      }
    }
  });
}

function drawHighwayGraphics() {
  const skyGrad = ctx.createLinearGradient(0, 0, 0, canvas.height / 2);
  skyGrad.addColorStop(0, '#10052b');
  skyGrad.addColorStop(0.6, '#380a3c');
  skyGrad.addColorStop(1, '#661b3b');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height / 2);

  ctx.strokeStyle = 'rgba(255, 94, 151, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  const mountainCount = 6;
  const mtOffset = (gameState.roadZ * 0.05) % (canvas.width / mountainCount);
  
  for (let i = -1; i <= mountainCount + 1; i++) {
    const x = i * (canvas.width / mountainCount) - mtOffset;
    const height = 40 + Math.sin(i * 1.5) * 20;
    ctx.lineTo(x + 50, canvas.height / 2 - height);
    ctx.lineTo(x + 100, canvas.height / 2);
  }
  ctx.stroke();

  ctx.fillStyle = '#0f170f';
  ctx.fillRect(0, canvas.height / 2, canvas.width, canvas.height / 2);

  const horizon = canvas.height / 2;
  const roadWidthStart = canvas.width - 100;
  const roadWidthEnd = 30;

  for (let y = canvas.height; y > horizon; y -= 4) {
    const percent = (y - horizon) / (canvas.height - horizon);
    
    const width = roadWidthEnd + (roadWidthStart - roadWidthEnd) * (percent * percent);
    const curveOffset = Math.sin(y * 0.005 + gameState.roadZ * 0.01) * gameState.roadCurve * 150 * (1 - percent);
    const centerX = canvas.width / 2 + curveOffset;
    
    const segment = Math.floor((y + gameState.roadZ * 0.5) / 15) % 2;
    const roadColor = '#212224';
    const borderStripe = segment === 0 ? '#ff5e97' : '#ffffff';
    
    ctx.fillStyle = borderStripe;
    ctx.fillRect(centerX - width / 2 - 10, y, width + 20, 4);

    ctx.fillStyle = roadColor;
    ctx.fillRect(centerX - width / 2, y, width, 4);

    if (segment === 0) {
      ctx.fillStyle = '#ffc02e';
      ctx.fillRect(centerX - 2, y, 4, 4);
    }
  }

  gameState.opponentCars.forEach(car => {
    if (car.z > 400 || car.z < 2) return;
    
    const percent = 30 / car.z;
    if (percent > 1.5) return;
    
    const horizon = canvas.height / 2;
    const curveOffset = Math.sin((horizon + car.z) * 0.005 + gameState.roadZ * 0.01) * gameState.roadCurve * 150 * (1 - percent);
    
    const widthAtZ = 30 + (canvas.width - 100) * (percent * percent);
    const roadCenterX = canvas.width / 2 + curveOffset;
    const carX = roadCenterX + (car.x * widthAtZ / 2);
    const carY = horizon + (canvas.height - horizon) * percent;
    
    const carWidth = 35 * percent;
    const carHeight = 20 * percent;

    if (carY > canvas.height + 50 || carY < horizon) return;

    ctx.shadowBlur = 8;
    ctx.shadowColor = car.color;
    ctx.strokeStyle = car.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(carX - carWidth/2, carY - carHeight, carWidth, carHeight);
    
    ctx.fillStyle = '#000';
    ctx.fillRect(carX - carWidth/2 - 4, carY - 6, 4, 6);
    ctx.fillRect(carX + carWidth/2, carY - 6, 4, 6);
    
    ctx.fillStyle = '#ff3b30';
    ctx.fillRect(carX - carWidth/2 + 2, carY - carHeight + 2, 4, 3);
    ctx.fillRect(carX + carWidth/2 - 6, carY - carHeight + 2, 4, 3);
    
    ctx.shadowBlur = 0;
  });

  const playerWidth = 90;
  const playerHeight = 50;
  const playerScreenX = canvas.width / 2 + (gameState.playerX * (roadWidthStart / 2.3));
  
  ctx.shadowBlur = 15;
  ctx.shadowColor = '#00f0ff';
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.strokeRect(playerScreenX - playerWidth/2, gameState.playerY + 20, 15, 30);
  ctx.strokeRect(playerScreenX + playerWidth/2 - 15, gameState.playerY + 20, 15, 30);
  ctx.moveTo(playerScreenX - playerWidth/3, gameState.playerY + 35);
  ctx.lineTo(playerScreenX - playerWidth/3, gameState.playerY);
  ctx.lineTo(playerScreenX + playerWidth/3, gameState.playerY);
  ctx.lineTo(playerScreenX + playerWidth/3, gameState.playerY + 35);
  ctx.closePath();
  ctx.stroke();

  ctx.strokeRect(playerScreenX - playerWidth/2 + 5, gameState.playerY - 12, playerWidth - 10, 8);
  
  ctx.strokeStyle = '#ff3b30';
  ctx.shadowColor = '#ff3b30';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playerScreenX - playerWidth/3 + 4, gameState.playerY + 5);
  ctx.lineTo(playerScreenX - playerWidth/6, gameState.playerY + 5);
  ctx.moveTo(playerScreenX + playerWidth/6, gameState.playerY + 5);
  ctx.lineTo(playerScreenX + playerWidth/3 - 4, gameState.playerY + 5);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.font = "12px 'Press Start 2P', monospace";
  ctx.fillStyle = '#fff';
  ctx.fillText(`SCORE: ${gameState.score}`, 20, 40);
  ctx.fillStyle = '#00e676';
  ctx.fillText(`SPEED: ${Math.floor(gameState.speed * 25)}KM/H`, 20, 65);
  
  ctx.fillStyle = '#ff5e97';
  ctx.fillText(`HI-SCORE: ${gameState.highScore}`, canvas.width - 240, 40);

  ctx.fillStyle = '#8e95a5';
  ctx.fillText("SELECT: RETURN TO MENU", 20, canvas.height - 20);

  // Speedometer Gear Dial UI (Bottom Right)
  const kmh = Math.floor(gameState.speed * 25);
  let gear = 1;
  if (kmh > 200) gear = 5;
  else if (kmh > 150) gear = 4;
  else if (kmh > 100) gear = 3;
  else if (kmh > 50) gear = 2;

  const dialX = canvas.width - 90;
  const dialY = canvas.height - 90;
  const dialR = 50;
  
  ctx.beginPath();
  ctx.arc(dialX, dialY, dialR, Math.PI * 0.8, Math.PI * 2.2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 8;
  ctx.stroke();
  
  ctx.beginPath();
  const speedRatio = gameState.speed / 10;
  const endAngle = Math.PI * 0.8 + (Math.PI * 1.4 * speedRatio);
  ctx.arc(dialX, dialY, dialR, Math.PI * 0.8, endAngle);
  
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#00f0ff';
  ctx.strokeStyle = '#00f0ff';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  
  ctx.font = "bold 14px 'Press Start 2P', monospace";
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(kmh, dialX, dialY + 5);
  
  ctx.font = "8px 'Press Start 2P', monospace";
  ctx.fillStyle = '#8e95a5';
  ctx.fillText("KM/H", dialX, dialY + 20);
  
  ctx.fillStyle = '#ffc02e';
  ctx.fillText(`GEAR ${gear}`, dialX, dialY - 15);
  ctx.textAlign = 'left';

  if (gameState.gameOver) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.font = "24px 'Press Start 2P', monospace";
    ctx.fillStyle = '#ff5252';
    ctx.textAlign = 'center';
    ctx.fillText("CAR CRASHED!", canvas.width / 2, canvas.height / 2 - 40);

    ctx.font = "12px 'Press Start 2P', monospace";
    ctx.fillStyle = '#fff';
    ctx.fillText(`FINAL SCORE: ${gameState.score}`, canvas.width / 2, canvas.height / 2 + 10);
    ctx.fillStyle = '#a4c639';
    ctx.fillText("PRESS 'START' TO RETRY RUN", canvas.width / 2, canvas.height / 2 + 50);
    
    ctx.fillStyle = '#8e95a5';
    ctx.fillText("PRESS 'SELECT' FOR MAIN BIOS MENU", canvas.width / 2, canvas.height / 2 + 90);
    ctx.textAlign = 'left';
  }
}// -------------------------------------------------------------
// POST Saves / GET Saves / DELETE Saves on Server Database
// -------------------------------------------------------------
function saveScoreToServer(gameName, score) {
  let targetSlot = 0;
  const occupiedSlots = serverSavesList.map(s => s.slot);
  for (let i = 0; i < 15; i++) {
    if (!occupiedSlots.includes(i)) {
      targetSlot = i;
      break;
    }
  }

  const token = localStorage.getItem('mge_session_token');
  fetch('/api/saves', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      game: gameName,
      score: score,
      slot: targetSlot
    })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      fetchSavesFromServer();
    }
  })
  .catch(err => console.error("Failed to post score to DB: ", err));
}

function updateMemoryCardUI() {
  const container = document.getElementById('mem-card-container');
  const containerProfile = document.getElementById('mem-card-container-profile');
  if (!container) return;
  container.innerHTML = '';
  if (containerProfile) containerProfile.innerHTML = '';
  
  const saveMap = {};
  serverSavesList.forEach(s => {
    saveMap[s.slot] = s;
  });

  for (let i = 0; i < 15; i++) {
    const item = saveMap[i];
    const block = document.createElement('div');
    block.className = 'mem-block';
    
    let blockProfile = null;
    if (containerProfile) {
      blockProfile = document.createElement('div');
      blockProfile.className = 'mem-block';
    }
    
    if (item) {
      block.classList.add('occupied');
      block.innerHTML = `
        <span class="mem-block-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="mem-icon">💾</span>
        <div class="mem-tooltip">
          <strong>${item.game}</strong><br>
          النقاط: ${item.score}<br>
          تاريخ: ${item.date}<br>
          <span style="color: #ff5252; cursor: pointer;" onclick="deleteSaveFromServer(${i}, event)">[حذف 🗑️]</span>
        </div>
      `;
      if (blockProfile) {
        blockProfile.classList.add('occupied');
        blockProfile.innerHTML = block.innerHTML;
      }
    } else {
      block.innerHTML = `
        <span class="mem-block-num">${String(i + 1).padStart(2, '0')}</span>
        <span class="mem-icon" style="color: rgba(255,255,255,0.15)">➖</span>
        <div class="mem-tooltip">خانة فارغة</div>
      `;
      if (blockProfile) {
        blockProfile.innerHTML = block.innerHTML;
      }
    }
    
    container.appendChild(block);
    if (containerProfile && blockProfile) {
      containerProfile.appendChild(blockProfile);
    }
  }
}

function deleteSaveFromServer(slot, event) {
  event.stopPropagation();
  if (confirm("هل أنت متأكد من رغبتك في مسح ملف الحفظ هذا نهائياً من قاعدة بيانات السيرفر؟")) {
    const token = localStorage.getItem('mge_session_token');
    fetch(`/api/saves/${slot}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        fetchSavesFromServer();
        playBeepSound(200, 0.2, 'sawtooth');
      }
    })
    .catch(err => console.error("Failed to delete save block: ", err));
  }
}

// -------------------------------------------------------------
// POST Upload ROM files to server and display library
// -------------------------------------------------------------
function triggerRomUpload() {
  document.getElementById('rom-file-input').click();
  playBeepSound(400, 0.05);
}

document.getElementById('rom-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    if (!isPowerOn) {
      alert("الرجاء تشغيل جهاز الألعاب أولاً (اضغط على زر الطاقة الأحمر)!");
      return;
    }

    stopGame();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = "14px 'Press Start 2P', monospace";
    ctx.fillStyle = '#ff5e97';
    ctx.textAlign = 'center';
    ctx.fillText("UPLOADING ROM TO SERVER DB...", canvas.width/2, canvas.height/2 - 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${file.name.substring(0, 24)}`, canvas.width/2, canvas.height/2 + 10);
    ctx.fillText("PLEASE WAIT...", canvas.width/2, canvas.height/2 + 40);
    ctx.textAlign = 'left';

    const formData = new FormData();
    formData.append('rom', file);

    const token = localStorage.getItem('mge_session_token');
    fetch('/api/roms/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        alert(`💿 تمت إضافة اللعبة "${file.name}" لقاعدة بيانات السيرفر بنجاح!`);
        fetchRomsFromServer();
      } else {
        alert("فشل رفع اللعبة: " + resData.message);
        enterBiosMenu();
      }
    })
    .catch(err => {
      console.error("Upload error: ", err);
      alert("فشل الإرسال للسيرفر. تأكد من تشغيل الخادم.");
      enterBiosMenu();
    });
  }
});

function updateRomsLibraryUI() {
  const container = document.getElementById('server-roms-list');
  const containerProfile = document.getElementById('server-roms-list-profile');
  if (!container) return;
  
  // Filter out preloaded roms from the dashboard uploaded rom list
  const customRoms = serverRomsList.filter(r => !r.preloaded);

  if (customRoms.length === 0) {
    container.innerHTML = `<div class="setting-label" style="text-align: center; padding: 0.5rem; color: var(--text-muted);">لا توجد ألعاب مرفوعة حالياً. ارفع أول ألعابك!</div>`;
    if (containerProfile) {
      containerProfile.innerHTML = `<div class="setting-label" style="text-align: center; padding: 0.5rem; color: var(--text-muted);">لا توجد ألعاب مرفوعة حالياً.</div>`;
    }
    return;
  }
  
  container.innerHTML = '';
  if (containerProfile) containerProfile.innerHTML = '';
  
  customRoms.forEach(rom => {
    const isUrl = rom.filename.startsWith('http://') || rom.filename.startsWith('https://');
    const sizeStr = isUrl ? "رابط خارجي 🔗" : `${(rom.size / (1024 * 1024)).toFixed(1)}MB`;

    const row = document.createElement('div');
    row.className = 'rom-item-row';
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.style.padding = '0.5rem 0.8rem';
    row.innerHTML = `
      <span style="font-weight: 700; color: #fff; font-size: 0.85rem;">💿 ${rom.name.substring(0, 24)}</span>
      <div style="display: flex; gap: 0.8rem; align-items: center;">
        <span style="color: var(--text-muted); font-size: 0.65rem;">${sizeStr}</span>
        <button class="play-btn" style="background: none; border: none; color: var(--neon-border); font-size: 0.72rem; cursor: pointer; font-weight: bold; font-family: inherit;">🕹️ تشغيل</button>
        <button class="dl-btn" style="background: none; border: none; color: #00ff66; font-size: 0.72rem; cursor: pointer; font-weight: bold; font-family: inherit;">📥 تحميل</button>
      </div>
    `;
    
    const rowProfile = row.cloneNode(true);
    
    const playHandler = (e) => {
      e.stopPropagation();
      if (isPowerOn) {
        const combIdx = serverRomsList.findIndex(r => r.id === rom.id);
        if (combIdx !== -1) {
          selectedGameIndex = combIdx;
          bootSelectedGame();
        }
      } else {
        alert("قم بتشغيل جهاز الألعاب أولاً (اضغط على زر الطاقة الأحمر)!");
      }
    };

    const downloadHandler = (e) => {
      e.stopPropagation();
      downloadRom(rom.filename, rom.id);
    };

    row.querySelector('.play-btn').onclick = playHandler;
    row.querySelector('.dl-btn').onclick = downloadHandler;
    rowProfile.querySelector('.play-btn').onclick = playHandler;
    rowProfile.querySelector('.dl-btn').onclick = downloadHandler;
    
    container.appendChild(row);
    if (containerProfile) {
      containerProfile.appendChild(rowProfile);
    }
  });
}

function downloadLocalApp(filename) {
  playBeepSound(500, 0.08);
  
  // High-speed official mirrors for emulators (prevents server bandwidth choke and runs real working files)
  const mirrors = {
    'AetherSX2_PS2_Android.apk': 'https://archive.org/download/aethersx2_archive/AetherSX2-v1.5-3668.apk',
    'PCSX2_PS2_Windows.exe': 'https://github.com/PCSX2/pcsx2/releases/download/v1.7.5670/pcsx2-v1.7.5670-windows-x64-Qt.7z',
    'PPSSPP_PSP_Android.apk': 'https://www.ppsspp.org/files/1_17_1/ppsspp.apk',
    'RPCS3_PS3_Windows.zip': 'https://rpcs3.net/latest'
  };

  const url = mirrors[filename];
  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } else {
    const link = document.createElement('a');
    link.href = `/local-apps/${filename}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

function downloadRom(filename, romId) {
  playBeepSound(500, 0.08);

  // If the filename starts with http/https, it's an external link added by the user!
  if (filename.startsWith('http://') || filename.startsWith('https://')) {
    const link = document.createElement('a');
    link.href = filename;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return;
  }
  
  // High-speed direct mirrors for store games to prevent server load & provide real working ROMs
  const storeMirrors = {
    'ucity_psx.bin': 'https://archive.org/download/ucity-psx/ucity-psx.bin',
    'psx_doom.bin': 'https://archive.org/download/psx-doom-demo/psx-doom-demo.bin',
    'block_boy.bin': 'https://archive.org/download/super-block-boy-psx/super-block-boy-psx.bin',
    'hubble_space.bin': 'https://archive.org/download/hubble-space-hunter-psx/hubble-space-hunter-psx.bin',
    'formula_retro_gp.bin': 'https://archive.org/download/formula-retro-gp-psx/formula-retro-gp-psx.bin',
    'memcard_tool.bin': 'https://archive.org/download/memcard-tool-psx/memcard-tool-psx.bin',
    'galaxy_striker_1999.bin': 'https://archive.org/download/hubble-space-hunter-psx/hubble-space-hunter-psx.bin',
    'formula_retro_racing.bin': 'https://archive.org/download/formula-retro-gp-psx/formula-retro-gp-psx.bin',
    'memory_card_manager.bin': 'https://archive.org/download/memcard-tool-psx/memcard-tool-psx.bin'
  };

  const mirrorUrl = storeMirrors[filename];
  if (mirrorUrl) {
    const link = document.createElement('a');
    link.href = mirrorUrl;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } else {
    // Standard user-uploaded ROM download (relative request to Node.js server)
    const link = document.createElement('a');
    link.href = `/roms/${filename}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

function addRomViaLink() {
  const linkInput = document.getElementById('rom-link-input');
  const nameInput = document.getElementById('rom-name-input');
  if (!linkInput || !nameInput) return;

  const url = linkInput.value.trim();
  const name = nameInput.value.trim();

  if (!url || !name) {
    alert("الرجاء إدخال اسم اللعبة ورابط التحميل المباشر!");
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    alert("الرجاء إدخال رابط إنترنت صحيح يبدأ بـ http:// أو https://");
    return;
  }

  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  playBeepSound(400, 0.05);

  fetch('/api/roms/add-link', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}` 
    },
    body: JSON.stringify({ name: name, url: url })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert(`💿 تم ربط اللعبة "${name}" بالرابط المباشر بنجاح!`);
      linkInput.value = '';
      nameInput.value = '';
      fetchRomsFromServer();
    } else {
      alert("فشل إضافة الرابط: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Add link error: ", err);
    alert("حدث خطأ أثناء التواصل مع السيرفر.");
  });
}

// -------------------------------------------------------------
// Interactive Guides and Modal Details
// -------------------------------------------------------------
const guidesData = {
  ps2: {
    title: "📖 دليل تشغيل ألعاب PlayStation 2 للهواتف والكمبيوتر",
    content: `
      <div class="guide-step">
        <h4 class="guide-step-title">1. تحميل وتثبيت تطبيق المحاكي المناسب:</h4>
        <p class="guide-step-desc">
          - <strong>لهواتف الأندرويد (Android)</strong>: قم بتنزيل محاكي <strong>NetherSX2</strong> أو <strong>AetherSX2</strong> (نسخة مجانية بالكامل وخارقة السرعة).<br>
          - <strong>لهواتف الآيفون (iOS)</strong>: استخدم محاكي <strong>Play!</strong> المتوفر عبر متجر AltStore.<br>
          - <strong>للكمبيوتر (Windows/Mac)</strong>: قم بتنزيل محاكي <strong>PCSX2</strong> (المحاكي الأفضل عالمياً وعالي الدقة).
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">2. تحميل ملف البيوس الأساسي (PS2 BIOS):</h4>
        <p class="guide-step-desc">
          لكي يعمل المحاكي، سيتطلب ملف نظام البيوس. يمكنك تحميل ملف <strong>SCPH-90001 BIOS</strong> بشكل مجاني وآمن من مواقع المحاكيات المعتمدة، ثم قم بربطه داخل إعدادات التطبيق.
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">3. تنزيل وتشغيل الألعاب (ROMs):</h4>
        <p class="guide-step-desc">
          يجب تنزيل الألعاب بصيغة <strong>.ISO</strong> أو <strong>.BIN</strong>. يمكنك تنزيل ألعابك المفضلة من مواقع شهيرة مثل Romspedia أو CoolROM، ثم ضعها في مجلد على هاتفك، وافتح المحاكي واختر المجلد لتبدأ اللعب فوراً!
        </p>
      </div>
    `
  },
  psp: {
    title: "📖 دليل تشغيل ألعاب PlayStation Portable (PSP) السريع",
    content: `
      <div class="guide-step">
        <h4 class="guide-step-title">1. تثبيت محاكي PPSSPP:</h4>
        <p class="guide-step-desc">
          قم بالدخول على متجر التطبيقات الخاص بهاتفك (Google Play Store لأندرويد، أو App Store للآيفون) وابحث عن <strong>PPSSPP</strong> وقم بتثبيته مجاناً. هو محاكي مستقر للغاية ويعمل بسرعة فائقة.
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">2. تشغيل الألعاب مباشرة بدون بيوس:</h4>
        <p class="guide-step-desc">
          على عكس باقي المحاكيات، محاكي PSP <strong>لا يحتاج لملفات بيوس خارجية!</strong> سيعمل فوراً بمجرد تحميل ملف اللعبة.
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">3. تنسيقات الألعاب وطريقة التشغيل:</h4>
        <p class="guide-step-desc">
          ابحث عن ألعاب PSP بصيغة <strong>.ISO</strong> أو <strong>.CSO</strong> (الملفات المضغوطة). بعد تحميل اللعبة، افتح تطبيق PPSSPP، اذهب لعلامة التبويب "ألعاب" واختر مكان تحميل اللعبة واستمتع بدقة الـ HD الفائقة!
        </p>
      </div>
    `
  },
  ps3: {
    title: "📖 دليل تشغيل ألعاب PlayStation 3 (PS3) للكمبيوتر",
    content: `
      <div class="guide-step">
        <h4 class="guide-step-title">1. متطلبات التشغيل الأساسية:</h4>
        <p class="guide-step-desc">
          محاكاة الـ PS3 تتطلب جهاز كمبيوتر حديث. يوصى بوجود معالج 6 أنوية فما فوق (Intel Core i5/Ryzen 5) وكارت شاشة خارجي يدعم Vulkan.
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">2. تثبيت محاكي RPCS3 وتحديث النظام:</h4>
        <p class="guide-step-desc">
          قم بتنزيل محاكي <strong>RPCS3</strong> الرسمي لنظام الويندوز أو الماك. بعد التثبيت، يجب عليك الذهاب لموقع Sony الرسمي وتحميل تحديث نظام الـ PS3 الرسمي (PS3UPDAT.PUP) وتثبيته داخل المحاكي لتعريف ملفات النظام والتشغيل.
        </p>
      </div>
      <div class="guide-step">
        <h4 class="guide-step-title">3. استيراد الألعاب وتشغيلها:</h4>
        <p class="guide-step-desc">
          تنزيل الألعاب يكون إما بصيغة مجلدات ألعاب كاملة أو ملفات <strong>.PKG</strong>. يتم سحب الملفات وإفلاتها داخل المحاكي، وتجهيز الإعدادات الافتراضية، وسيقوم المحاكي بعمل compile للمحركات لتبدأ اللعبة بدقة تصل إلى 4K كاملة!
        </p>
      </div>
    `
  }
};

function showGuide(consoleKey) {
  const guide = guidesData[consoleKey];
  if (!guide) return;
  document.getElementById('modal-title').innerText = guide.title;
  document.getElementById('modal-body-content').innerHTML = guide.content;
  const modal = document.getElementById('guide-modal');
  modal.classList.add('active');
  playBeepSound(600, 0.08);
}

function closeGuide() {
  const modal = document.getElementById('guide-modal');
  modal.classList.remove('active');
  playBeepSound(400, 0.05);
}

function showTermsModal() {
  const modal = document.getElementById('terms-modal');
  if (modal) {
    modal.classList.add('active');
    playBeepSound(600, 0.08);
  }
}

function closeTermsModal() {
  const modal = document.getElementById('terms-modal');
  if (modal) {
    modal.classList.remove('active');
    playBeepSound(400, 0.05);
  }
}

function acceptTermsAndClose() {
  const checkbox = document.getElementById('reg-terms');
  const label = document.getElementById('label-reg-terms');
  if (checkbox) {
    checkbox.disabled = false;
    checkbox.checked = true;
    // Dispatch a native change event so the browser repaints the checkbox state immediately
    checkbox.dispatchEvent(new Event('change'));
  }
  if (label) {
    label.style.cursor = 'pointer';
    label.style.opacity = '1';
  }
  window.termsOpened = true;
  closeTermsModal();
  
  // Wrap alert in a longer timeout (500ms) to let the browser completely fade out the modal and paint the checkmark before blocking the thread
  setTimeout(() => {
    alert("🎉 تم قبول شروط الخدمة وسياسة الخصوصية بنجاح! يمكنك الآن تسجيل حسابك الجديد.");
  }, 500);
}


function openDownloadLink(consoleKey) {
  const links = { ps2: 'https://pcsx2.net/', psp: 'https://www.ppsspp.org/', ps3: 'https://rpcs3.net/' };
  const url = links[consoleKey];
  if (url) window.open(url, '_blank');
}

// -------------------------------------------------------------
// USER PROFILE & SYSTEM ADMINISTRATION CONTROLS (NEW)
// -------------------------------------------------------------

// Update User Profile Tab UI and Admin panel
function updateProfileUI() {
  const username = localStorage.getItem('mge_username');
  if (!username) return;

  document.getElementById('profile-username-display').innerText = username;

  const roleBadge = document.getElementById('profile-role-badge');
  const adminPanel = document.getElementById('admin-management-panel');
  const emailDisplay = document.getElementById('profile-email-display');

  // Show header logout button globally
  const headerLogoutBtn = document.getElementById('header-logout-btn');
  if (headerLogoutBtn) {
    headerLogoutBtn.style.display = 'flex';
  }

  // Load email
  let email = localStorage.getItem('mge_email');
  if (!email || email === 'undefined') {
    if (username === 'mamdouh') email = 'mamdouh1626@gmail.com';
    else if (username === 'admin') email = 'admin@mge.com';
    else email = 'guest@mge.com';
    localStorage.setItem('mge_email', email);
  }
  emailDisplay.innerText = email;

  if (username === 'guest') {
    roleBadge.innerText = 'حساب تجريبي محدود ⚠️';
    roleBadge.className = 'role-badge';
    roleBadge.style.background = 'linear-gradient(135deg, #ffc02e, #ff9100)';
    adminPanel.style.display = 'none';
  } else {
    roleBadge.innerText = 'مسؤول النظام 👑';
    roleBadge.className = 'role-badge admin-role';
    roleBadge.style.background = 'linear-gradient(135deg, #2979ff, #00e676)';
    adminPanel.style.display = 'block';

    // Prefill admin email modification input
    document.getElementById('admin-edit-email').value = email;
    
    // Fetch registered users list
    fetchUsersListForAdmin();
    
    // Fetch local apps too (for admin panel)
    fetchLocalApps();
  }
}

// Fetch all registered users from database server (Admin Only)
function fetchUsersListForAdmin() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  fetch('/api/admin/users', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      const container = document.getElementById('admin-users-list');
      container.innerHTML = '';
      
      const loggedInUser = localStorage.getItem('mge_username');
      
      resData.data.forEach(u => {
        const item = document.createElement('div');
        item.style.cssText = `
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.04);
          padding: 0.5rem 0.8rem;
          border-radius: 8px;
          font-size: 0.8rem;
          margin-bottom: 0.4rem;
        `;
        
        let badge = u.username === 'guest' ? '<span style="color: #ff9100; font-size: 0.7rem; font-weight: bold;">زائر ⚠️</span>' : '<span style="color: #00ff66; font-size: 0.7rem; font-weight: bold;">مسؤول 👑</span>';
        let bioStatus = u.webauthnEnabled ? '<span style="color: #2979ff; font-weight: 600;">البصمة مفعّلة 🛡️</span>' : '<span style="color: var(--text-muted);">بصمة غير مسجلة</span>';
        
        let deleteBtnHtml = '';
        if (u.username !== loggedInUser && u.username !== 'admin' && u.username !== 'mamdouh') {
          deleteBtnHtml = `<button class="delete-user-btn" onclick="deleteUserFromServer('${u.username}')">🗑️ حذف</button>`;
        }
        
        item.innerHTML = `
          <div style="text-align: right; line-height: 1.4;">
            <strong style="color: #fff;">${u.username}</strong> <span style="font-size: 0.75rem; color: var(--text-muted);">(${u.email})</span><br>
            ${bioStatus}
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            ${badge}
            ${deleteBtnHtml}
          </div>
        `;
        container.appendChild(item);
      });
    }
  })
  .catch(err => console.error("Failed to load admin users list: ", err));
}

// Save Admin account changes (Email and/or Password)
function saveAdminSettings() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  const newEmail = document.getElementById('admin-edit-email').value;
  const newPassword = document.getElementById('admin-edit-password').value;

  if (!newEmail) {
    alert("⚠️ لا يمكن إبقاء البريد الإلكتروني فارغاً!");
    return;
  }

  const bodyData = { email: newEmail };
  if (newPassword) {
    bodyData.password = newPassword;
  }

  fetch('/api/admin/update', {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(bodyData)
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      localStorage.setItem('mge_email', newEmail);
      document.getElementById('admin-edit-password').value = '';
      updateProfileUI();
    } else {
      alert("⚠️ فشل التعديل: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Update failed: ", err);
    alert("تعذر الاتصال بالخادم لحفظ التعديلات!");
  });
}

// Securely Logout user from portal
function submitLogout() {
  // Clear session storage
  localStorage.removeItem('mge_session_token');
  localStorage.removeItem('mge_username');
  localStorage.removeItem('mge_email');
  
  // Set logout intent to prevent auto-login loop
  localStorage.setItem('mge_logout_intent', 'true');
  
  // Reload page to bring back auth screen
  alert("🔑 تم تسجيل الخروج من البوابة الآمنة بنجاح!");
  location.reload();
}

// -------------------------------------------------------------
// RELIABLE MGE AI ASSISTANT CHATBOT (NEW)
// -------------------------------------------------------------

// MGE Reliable AI Chatbot Q&A Engine
function askAiQuestion(question) {
  document.getElementById('ai-user-prompt').value = question;
  submitAiPrompt();
}

function submitAiPrompt() {
  const inputEl = document.getElementById('ai-user-prompt');
  const prompt = inputEl.value.trim();
  if (!prompt) return;

  // Clear input
  inputEl.value = '';

  // Append user message to chat box
  appendChatMessage(prompt, 'user');

  // Show typing indicator
  const chatBox = document.getElementById('ai-chat-box');
  const typingDiv = document.createElement('div');
  typingDiv.id = 'ai-typing-indicator';
  typingDiv.className = 'chat-msg msg-ai';
  typingDiv.style.cssText = `
    align-self: flex-start;
    max-width: 85%;
    text-align: right;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.6rem 1rem;
    border-radius: 16px 16px 16px 4px;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-style: italic;
  `;
  typingDiv.innerHTML = `جاري التفكير وكتابة الإجابة الموثوقة... 🧠`;
  chatBox.appendChild(typingDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  // Run AI logic after a 1.2 second dynamic delay (simulating processing)
  setTimeout(() => {
    // Remove typing indicator
    const indicator = document.getElementById('ai-typing-indicator');
    if (indicator) indicator.remove();

    // Get response
    const answer = getAiReliableAnswer(prompt);
    
    // Append AI response
    appendChatMessage(answer, 'ai');
  }, 1200);
}

function appendChatMessage(text, sender) {
  const chatBox = document.getElementById('ai-chat-box');
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg msg-${sender}`;
  
  if (sender === 'user') {
    msgDiv.style.cssText = `
      align-self: flex-end;
      max-width: 85%;
      text-align: right;
      background: rgba(41, 121, 255, 0.1);
      border: 1px solid rgba(41, 121, 255, 0.2);
      padding: 0.6rem 1rem;
      border-radius: 16px 16px 4px 16px;
      color: #fff;
      font-size: 0.82rem;
      margin-bottom: 0.6rem;
    `;
    msgDiv.innerHTML = `
      <div style="font-weight: bold; color: #ffc02e; font-size: 0.72rem; margin-bottom: 0.2rem;">👤 أنت:</div>
      ${text}
    `;
  } else {
    msgDiv.style.cssText = `
      align-self: flex-start;
      max-width: 85%;
      text-align: right;
      background: rgba(41, 121, 255, 0.15);
      border: 1px solid rgba(41, 121, 255, 0.3);
      padding: 0.6rem 1rem;
      border-radius: 16px 16px 16px 4px;
      color: #fff;
      font-size: 0.82rem;
      margin-bottom: 0.6rem;
    `;
    msgDiv.innerHTML = `
      <div style="font-weight: bold; color: #2979ff; font-size: 0.72rem; margin-bottom: 0.2rem; display: flex; align-items: center; gap: 0.3rem;">🧠 المساعد الذكي للألعاب:</div>
      ${text}
    `;
  }
  
  chatBox.appendChild(msgDiv);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Highly reliable, offline-capable Contextual AI Knowledge Database for Retro Gaming
function getAiReliableAnswer(prompt) {
  const cleanPrompt = prompt.toLowerCase();
  
  // 1. BIOS queries
  if (cleanPrompt.includes('bios') || cleanPrompt.includes('بايوس') || cleanPrompt.includes('إقلاع') || cleanPrompt.includes('صوت')) {
    return `
      يتميز محاكي <strong>ألعاب الزمن الجميل</strong> بتخليق إشارة <strong>BIOS</strong> سحابية أصلية تماثل الأجهزة الحقيقية!
      <br>• يمكنك ضبط وتغيير شكل نغمة التشغيل الترحيبية من إعدادات لوحة التحكم بالصفحة الرئيسية.
      <br>• الأصوات التوليفية المدعومة تشمل: <strong>PS1 الكلاسيكي</strong>، <strong>PS2 العميق</strong>، <strong>PSP المحمول</strong>، و <strong>PS3 الأوركسترالي</strong>.
      <br>• يتم توليد جميع هذه الأصوات فورياً في متصفحك باستخدام تقنية <strong>HTML5 Web Audio Synthesizer</strong> لضمان أسرع وقت استجابة ونقاء صوت.
    `;
  }
  
  // 2. Play game
  if (cleanPrompt.includes('لعبة') || cleanPrompt.includes('ألعاب') || cleanPrompt.includes('تشغيل') || cleanPrompt.includes('كيف') || cleanPrompt.includes('شغل')) {
    if (cleanPrompt.includes('رفع') || cleanPrompt.includes('ارفع') || cleanPrompt.includes('روم')) {
      return `
        لرفع وتشغيل أي لعبة خاصة بك (.bin أو .cue):
        <br>1. تأكد من تسجيل الدخول بحسابك الإداري <strong>(mamdouh)</strong>.
        <br>2. اسحب ملف اللعبة وأسقطه في صندوق الرفع 💿 أسفل يسار لوحة المحاكي، أو انقر عليه لتحديد الملف.
        <br>3. سيتم تشفير اللعبة وحفظها سحابياً في الخادم وتظهر في مكتبة الألعاب المرفوعة.
        <br>4. انقر فوق اللعبة المرفوعة من القائمة لتلقيمها في منفذ الأقراص للمحاكي فوراً!
      `;
    }
    return `
      لتشغيل أي لعبة على المحاكي:
      <br>1. اضغط على زر 🔌 الطاقة الأحمر الموجود على شاشة التلفزيون الافتراضي لبدء عملية الإقلاع وسماع نغمة الـ BIOS.
      <br>2. بعد انتهاء شاشة ترحيب PlayStation، ستدخل إلى قائمة النظام.
      <br>3. حدد اللعبة التي ترغب بها (مثل Galaxy Striker 1999 أو Formula Racing) باستخدام أزرار التحكم الافتراضية أو كيبورد جهازك.
      <br>4. اضغط <strong>START</strong> لبدء اللعب فوراً والاستمتاع!
    `;
  }
  
  // 3. Biometrics
  if (cleanPrompt.includes('بصمة') || cleanPrompt.includes('بصمه') || cleanPrompt.includes('windows hello') || cleanPrompt.includes('أمان') || cleanPrompt.includes('حماية')) {
    return `
      بوابة <strong>ألعاب الزمن الجميل</strong> تدعم الدخول السريع والآمن المتكامل عبر نظام التشغيل وجهازك الخاص!
      <br>• <strong>كيفية التفعيل:</strong> بعد تسجيل الدخول لأول مرة بحسابك، سيقترح عليك النظام ربط الجهاز. يمكنك أيضاً تفعيل الميزة بالنقر على زر 🔒 <strong>"ربط بصمة الجهاز 🛡️"</strong> في الإعدادات.
      <br>• <strong>كيفية الاستخدام:</strong> في المرة القادمة، بمجرد فتح البوابة، سيظهر لك زر أخضر كبير: <em>"دخول سريع بأمان الجهاز (Windows Hello)"</em>. انقر عليه وضع إصبعك على قارئ البصمة أو أدخل رمز الـ PIN الخاص بجهازك للدخول الفوري!
    `;
  }
  
  // 4. Guest limitations
  if (cleanPrompt.includes('زائر') || cleanPrompt.includes('تجريبي') || cleanPrompt.includes('guest') || cleanPrompt.includes('قيود')) {
    return `
      الحساب التجريبي <strong>(guest)</strong> مصمم لغرض المعاينة السريعة فقط لحماية السيرفر من الهجمات التخريبية!
      <br>• <strong>ما هي قيوده؟</strong> لا يمكن للزائر رفع ألعاب خاصة به، ولا يمكنه حفظ درجات التخزين (Memory Card blocks)، كما أنه يُحظر برمجياً من ربط بصمة الإصبع.
      <br>• <strong>الحل:</strong> ننصحك بشدة بالتسجيل بحساب رسمي جديد أو استخدام حسابك الإداري المخصص <strong>mamdouh</strong> للتمتع بكامل الصلاحيات المطلقة بدون أي قيود!
    `;
  }
  
  // 5. Server cryptography & Saves Backup guide
  if (cleanPrompt.includes('استيراد') || cleanPrompt.includes('تصدير') || cleanPrompt.includes('تخزين') || cleanPrompt.includes('saves')) {
    return `
      يمكنك استيراد وتصدير درجات التخزين الخاصة بكرت الذاكرة السحابي بكل سهولة!
      <br>• <strong>التصدير:</strong> اضغط على زر "تصدير نسخة التخزين" في تبويب الملف الشخصي لتحميل ملف <strong>saves_backup.json</strong> يحتوي على تقدمك الحالي.
      <br>• <strong>الاستيراد:</strong> اضغط على زر "استيراد نسخة التخزين" واختر ملف التخزين المحفوظ لديك ليتم دمجه وتحديث كروت الذاكرة فوراً!
    `;
  }
  
  if (cleanPrompt.includes('تشفير') || cleanPrompt.includes('سيرفر') || cleanPrompt.includes('database') || cleanPrompt.includes('حماية') || cleanPrompt.includes('ثغرة') || cleanPrompt.includes('أمن')) {
    return `
      تعتمد بوابة <strong>ألعاب الزمن الجميل</strong> على معايير حماية فائقة الأمان مطابقة للمواصفات القياسية العالمية.
      تم تأمين وحفظ كلمات المرور وحماية قواعد البيانات بالكامل لضمان سرية حساباتك وألعابك بشكل آمن وتلقائي دون إعلان أي تفاصيل تقنية لضمان خصوصيتك.
    `;
  }

  // 6. Controller layout & skins
  if (cleanPrompt.includes('يد') || cleanPrompt.includes('تحكم') || cleanPrompt.includes('شكل') || cleanPrompt.includes('controller') || cleanPrompt.includes('أزرار')) {
    return `
      يمكنك تخصيص شكل يد التحكم بالكامل لتلائم ذوقك الفني!
      <br>• <strong>الخامات المدعومة:</strong> يد التحكم الكلاسيكية (رمادي)، يد تحكم النيون المضيء (أزرق متوهج)، يد تحكم الخشب العتيق، أو تصميم الكريستال الشفاف.
      <br>• <strong>الأزرار الافتراضية:</strong> تشمل أزرار D-Pad للاتجاهات، وأزرار الأشكال التفاعلية (▲ مثلث، ● دائرة، ✖ إكس، ■ مربع)، بالإضافة إلى أزرار SELECT و START و L1/R1.
      <br>• <strong>دعم أيدي التحكم الخارجية:</strong> المحاكي يدعم الربط التلقائي عبر الـ <strong>Gamepad API</strong> لأيدي التحكم الحقيقية (مثل PS4/PS5 أو Xbox) بمجرد توصيلها بجهازك عبر USB أو بلوتوث!
    `;
  }

  // Default catch-all response
  return `
    سؤالك ذكي جداً ومميز! بخصوص <em>"${prompt}"</em>:
    <br>كـ <strong>مساعد ذكي موثوق</strong>، أؤكد لك أن منصة <strong>ألعاب الزمن الجميل</strong> مهيأة بالكامل لتقديم أفضل أداء.
    <br>إذا كنت تواجه مشكلة معينة أو تريد تفاصيل أدق، يرجى كتابة الكلمات المفتاحية مثل (BIOS، لعبة، البصمة، التخزين، الزائر) لأعطيك تفاصيل تقنية دقيقة فوراً! 🎮✨
  `;
}

// -------------------------------------------------------------
// ADDITIONAL MGE PORTAL HELPER METHODS (DYNAMIQUE)
// -------------------------------------------------------------

function deleteUserFromServer(username) {
  if (confirm(`هل أنت متأكد من رغبتك في حذف الحساب '${username}' نهائياً من قاعدة بيانات السيرفر؟`)) {
    const token = localStorage.getItem('mge_session_token');
    fetch('/api/admin/users/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ username: username })
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        alert(resData.message);
        fetchUsersListForAdmin();
        playBeepSound(200, 0.2, 'sawtooth');
      } else {
        alert("⚠️ فشل الحذف: " + resData.message);
      }
    })
    .catch(err => console.error("Delete user failed:", err));
  }
}

function savePortalName() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  const newName = document.getElementById('admin-edit-portal-name').value;
  if (!newName) {
    alert("⚠️ لا يمكن إبقاء اسم المنصة فارغاً!");
    return;
  }

  fetch('/api/admin/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ portal_name: newName })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      document.getElementById('app-title').innerText = newName;
      document.getElementById('admin-edit-portal-name').value = '';
    } else {
      alert("⚠️ فشل التحديث: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Update portal name failed:", err);
    alert("تعذر الاتصال بالخادم لحفظ التعديلات!");
  });
}

function fetchPortalConfig() {
  fetch('/api/config')
    .then(res => res.json())
    .then(resData => {
      if (resData.success && resData.portal_name) {
        document.getElementById('app-title').innerText = resData.portal_name;
      }
    })
    .catch(err => console.log("Failed to fetch portal config:", err));
}

function fetchLocalApps() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  fetch('/api/local-apps', {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      renderLocalAppsGrid(resData.data);
      renderAdminLocalAppsList(resData.data);
    }
  })
  .catch(err => console.error("Failed to load local apps:", err));
}

function renderLocalAppsGrid(apps) {
  const grid = document.getElementById('local-apps-grid');
  if (!grid) return;
  
  if (!apps || apps.length === 0) {
    grid.innerHTML = `<div class="setting-label" style="text-align: center; width: 100%; padding: 2rem; color: var(--text-muted);">لا توجد تطبيقات محلية مضافة حالياً.</div>`;
    return;
  }

  grid.innerHTML = '';
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
  const isWindows = /windows/i.test(userAgent);

  apps.forEach(app => {
    const card = document.createElement('div');
    const borderGlowClass = app.platform === 'Android' ? 'card-android-glow' : 'card-windows-glow';
    card.className = `local-app-card ${borderGlowClass}`;
    
    const platformBadgeClass = app.platform === 'Android' ? 'badge-android' : 'badge-windows';
    const cleanPackage = app.package.replace(/'/g, "\\'");
    const cleanName = app.name.replace(/'/g, "\\'");
    
    const isMatchedOS = (app.platform === 'Android' && (isAndroid || isIOS)) || (app.platform === 'Windows' && isWindows);
    const compatBadge = isMatchedOS ? `<div class="device-compatible-badge">⚡ متوافق مع جهازك</div>` : '';

    card.innerHTML = `
      <div class="local-app-icon">${app.icon || '🎮'}</div>
      <h3 class="local-app-name">${app.name}</h3>
      <div class="local-app-package">${app.package}</div>
      <div style="margin-bottom: 1.2rem;">
        <span class="local-app-badge ${platformBadgeClass}">${app.platform}</span>
        ${compatBadge}
      </div>
      <button class="download-action-btn" onclick="launchLocalApp('${cleanPackage}', '${cleanName}', '${app.icon || '🎮'}')" style="background: linear-gradient(135deg, #00ff66, #0078d7);">🕹️ تشغيل اللعبة الآن</button>
    `;
    grid.appendChild(card);
  });
}

function renderAdminLocalAppsList(apps) {
  const container = document.getElementById('admin-local-apps-list');
  if (!container) return;
  
  if (!apps || apps.length === 0) {
    container.innerHTML = `<div class="setting-label" style="text-align: center; padding: 0.5rem; color: var(--text-muted);">لا توجد تطبيقات مضافة.</div>`;
    return;
  }

  container.innerHTML = '';
  apps.forEach(app => {
    const item = document.createElement('div');
    item.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.04);
      padding: 0.4rem 0.8rem;
      border-radius: 8px;
      font-size: 0.8rem;
      margin-bottom: 0.3rem;
    `;
    
    item.innerHTML = `
      <div style="text-align: right; line-height: 1.4;">
        <strong style="color: #fff;">${app.icon || '🎮'} ${app.name}</strong> <span style="font-size: 0.72rem; color: var(--text-muted);">(${app.platform})</span><br>
        <span style="font-size: 0.68rem; color: var(--text-muted); font-family: monospace;">${app.package}</span>
      </div>
      <button class="delete-user-btn" onclick="deleteLocalApp('${app.id}')">🗑️ حذف</button>
    `;
    container.appendChild(item);
  });
}

function addLocalApp() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) return;

  const name = document.getElementById('admin-app-name').value.trim();
  const packageId = document.getElementById('admin-app-package').value.trim();
  const icon = document.getElementById('admin-app-icon').value.trim() || '🎮';
  const platform = document.getElementById('admin-app-platform').value;

  if (!name || !packageId) {
    alert("⚠️ يرجى إدخال اسم التطبيق وحزمته!");
    return;
  }

  fetch('/api/admin/local-apps', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ name, package: packageId, icon, platform })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      document.getElementById('admin-app-name').value = '';
      document.getElementById('admin-app-package').value = '';
      document.getElementById('admin-app-icon').value = '';
      
      fetchLocalApps();
      playBeepSound(600, 0.1, 'sine');
    } else {
      alert("⚠️ فشل إضافة التطبيق: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Add local app failed:", err);
    alert("تعذر الاتصال بالخادم لإضافة التطبيق!");
  });
}

function deleteLocalApp(id) {
  if (confirm("هل أنت متأكد من حذف هذا التطبيق المحلي من القائمة؟")) {
    const token = localStorage.getItem('mge_session_token');
    fetch('/api/admin/local-apps/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ id })
    })
    .then(res => res.json())
    .then(resData => {
      if (resData.success) {
        alert(resData.message);
        fetchLocalApps();
        playBeepSound(200, 0.2, 'sawtooth');
      } else {
        alert("⚠️ فشل الحذف: " + resData.message);
      }
    })
    .catch(err => console.error("Delete local app failed:", err));
  }
}

let simLauncherInterval = null;

function launchLocalApp(packageName, appName, appIcon) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(700, 0.12, 'triangle');

  const isAndroid = /Android/i.test(navigator.userAgent);
  
  if (isAndroid) {
    location.href = `intent://#Intent;scheme=android-app;package=${packageName};end`;
  } else {
    const overlay = document.getElementById('sim-launcher-overlay');
    const titleEl = document.getElementById('sim-app-title');
    const iconEl = document.getElementById('sim-app-icon');
    const progressBar = document.getElementById('sim-progress-bar');
    const statusLabel = document.getElementById('sim-status-label');
    const closeBtn = document.getElementById('sim-close-btn');

    titleEl.innerText = appName;
    iconEl.innerText = appIcon || '🎮';
    progressBar.style.width = '0%';
    statusLabel.innerText = 'مهيأ لتشغيل ملفات اللعبة...';
    closeBtn.style.display = 'none';

    overlay.classList.add('active');

    playStartupSound();

    let progress = 0;
    const statusMessages = [
      'جاري قراءة كتل الذاكرة من الهارد ديسك...',
      'تخصيص الذاكرة العشوائية وسرعة المحاكي...',
      'تهيئة محرك الجرافيكس ثلاثي الأبعاد...',
      'ربط خيوط المعالجة والتحكم...',
      'تم إطلاق اللعبة بنجاح! استمتع باللعب 🚀'
    ];

    clearInterval(simLauncherInterval);
    simLauncherInterval = setInterval(() => {
      progress += Math.random() * 8 + 4;
      if (progress >= 100) {
        progress = 100;
        clearInterval(simLauncherInterval);
        statusLabel.innerText = statusMessages[4];
        progressBar.style.width = '100%';
        closeBtn.style.display = 'block';
        playBeepSound(880, 0.2, 'sine');
      } else {
        progressBar.style.width = `${progress}%`;
        const msgIdx = Math.floor((progress / 100) * 4);
        statusLabel.innerText = statusMessages[msgIdx] || statusMessages[0];
      }
    }, 150);
  }
}

function closeSimulatedLauncher() {
  const overlay = document.getElementById('sim-launcher-overlay');
  overlay.classList.remove('active');
  playBeepSound(400, 0.05);
}

// Support changing the password securely for standard logged-in users with username & current password verification
function changeUserPassword() {
  const token = localStorage.getItem('mge_session_token');
  if (!token) {
    alert("⚠️ يجب تسجيل الدخول لتغيير كلمة المرور!");
    return;
  }
  const username = document.getElementById('user-change-username').value;
  const currentPassword = document.getElementById('user-current-password').value;
  const newPassword = document.getElementById('user-new-password').value;
  const confirmPassword = document.getElementById('user-new-password-confirm').value;

  if (!username || !currentPassword || !newPassword || !confirmPassword) {
    alert("⚠️ اسم المستخدم وكلمة المرور الحالية والجديدة حقول إجبارية!");
    return;
  }
  if (newPassword !== confirmPassword) {
    alert("⚠️ كلمتا المرور الجديدتان غير متطابقتين!");
    return;
  }
  fetch('/api/user/update-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ 
      username: username,
      currentPassword: currentPassword,
      password: newPassword 
    })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      document.getElementById('user-change-username').value = '';
      document.getElementById('user-current-password').value = '';
      document.getElementById('user-new-password').value = '';
      document.getElementById('user-new-password-confirm').value = '';
    } else {
      alert("⚠️ فشل التحديث: " + resData.message);
    }
  })
  .catch(err => {
    console.error("Password update error:", err);
    alert("تعذر الاتصال بالخادم لتغيير كلمة المرور!");
  });
}

// Speech Recognition / Voice-to-Text Feature for AI Assistant Chatbot
let recognition = null;
let isListeningSpeech = false;

function toggleVoiceTyping() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("⚠️ متصفحك الحالي لا يدعم ميزة التعرف على الصوت! يرجى استخدام متصفح Google Chrome أو Microsoft Edge.");
    return;
  }

  const voiceBtn = document.getElementById('btn-voice-typing');
  const promptInput = document.getElementById('ai-user-prompt');

  if (isListeningSpeech) {
    if (recognition) recognition.stop();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'ar-SA'; // Native Arabic recognition support
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    isListeningSpeech = true;
    voiceBtn.innerHTML = "🎙️🔴";
    voiceBtn.style.borderColor = "#ff3d00";
    voiceBtn.setAttribute('title', 'جاري الاستماع... اضغط للإيقاف');
    promptInput.placeholder = "🎙️ جاري الاستماع لصوتك... تحدث الآن باللغة العربية...";
    
    // Play a subtle high synthesized beep
    if (isPowerOn) playBeepSound(800, 0.05, 'sine');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    promptInput.value = transcript;
    
    // Play success beep
    if (isPowerOn) playBeepSound(1000, 0.06, 'sine');
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    if (event.error === 'not-allowed') {
      alert("⚠️ يرجى السماح للمتصفح بالوصول إلى الميكروفون لاستخدام ميزة الكتابة بالصوت!");
    } else if (event.error !== 'aborted') {
      alert("⚠️ حدث خطأ أثناء التعرف على الصوت: " + event.error);
    }
  };

  recognition.onend = () => {
    isListeningSpeech = false;
    voiceBtn.innerHTML = "🎙️";
    voiceBtn.style.borderColor = "";
    voiceBtn.setAttribute('title', 'الكتابة بالصوت 🎙️');
    promptInput.placeholder = "اكتب سؤالك هنا بخصوص المحاكي...";
  };

  recognition.start();
}

// MGE Retro Game Store: Instantly download & add free classic games to console
function installStoreGame(gameId) {
  const token = localStorage.getItem('mge_session_token');
  if (!token) {
    alert("⚠️ يرجى تسجيل الدخول لتنزيل وإضافة الألعاب المجانية إلى محاكيك!");
    return;
  }
  
  // Subtle audio synthesize feedback
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  playBeepSound(600, 0.1, 'sine');
  
  fetch('/api/store/install', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ gameId: gameId })
  })
  .then(res => res.json())
  .then(resData => {
    if (resData.success) {
      alert("🎉 " + resData.message);
      playBeepSound(880, 0.2, 'sine');
      
      // Refresh ROMs library instantly
      fetchRomsFromServer();
    } else {
      alert("⚠️ " + resData.message);
    }
  })
  .catch(err => {
    console.error("Store download failed:", err);
    alert("تعذر الاتصال بالخادم لتنزيل اللعبة من المتجر!");
  });
}

// -------------------------------------------------------------
// EXPERT DEVICE ADAPTABILITY & HARMONIZATION (NEW)
// -------------------------------------------------------------

function toggleVirtualController(visible) {
  const section = document.querySelector('.controllers-section');
  if (!section) return;
  
  const showBtn = document.getElementById('btn-show-controller');
  const hideBtn = document.getElementById('btn-hide-controller');
  
  if (visible) {
    section.style.display = 'grid';
    localStorage.setItem('mge_controller_visible', 'true');
    showBtn?.classList.add('active');
    hideBtn?.classList.remove('active');
  } else {
    section.style.display = 'none';
    localStorage.setItem('mge_controller_visible', 'false');
    showBtn?.classList.remove('active');
    hideBtn?.classList.add('active');
  }
}

function initDeviceAdaptation() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const isAndroid = /android/i.test(userAgent);
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
  const isMobile = isAndroid || isIOS || /Mobi/i.test(userAgent);
  const isWindows = /windows/i.test(userAgent);
  
  // 1. Set default virtual controller visibility based on device touch capability
  const savedControllerVis = localStorage.getItem('mge_controller_visible');
  if (savedControllerVis === 'true') {
    toggleVirtualController(true);
  } else if (savedControllerVis === 'false') {
    toggleVirtualController(false);
  } else {
    // Show by default on mobile, hide by default on PC
    toggleVirtualController(isMobile);
  }
  
  // 2. Highlight matching emulator download buttons with dynamic glowing badges
  if (isAndroid || isIOS) {
    document.querySelectorAll('.btn-platform-android').forEach(btn => {
      btn.style.boxShadow = '0 0 20px rgba(0, 230, 118, 0.55)';
      btn.innerHTML += ' ⚡ (متوافق مع هاتفك)';
    });
  } else if (isWindows) {
    document.querySelectorAll('.btn-platform-windows').forEach(btn => {
      btn.style.boxShadow = '0 0 20px rgba(41, 121, 255, 0.55)';
      btn.innerHTML += ' ⚡ (متوافق مع حاسوبك)';
    });
  }
}

