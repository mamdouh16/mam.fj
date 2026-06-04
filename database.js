const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'database.json');

// Internal credentials security derivation function
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 210000, 64, 'sha512').toString('hex');
}

// Generate a random secure salt
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Default Admin and Users securely hashed
const defaultSalt = generateSalt();
const defaultHash = hashPassword('admin', defaultSalt);

const mamdouhSalt = generateSalt();
const mamdouhHash = hashPassword('mamdouh10@', mamdouhSalt);

const guestSalt = generateSalt();
const guestHash = hashPassword('guest', guestSalt);

const malleaSalt = generateSalt();
const malleaHash = hashPassword('mallea10@', malleaSalt);

let dbData = {
  users: [
    {
      username: 'admin',
      email: 'admin@mge.com',
      passwordHash: defaultHash,
      salt: defaultSalt,
      webauthnCredentialId: null
    },
    {
      username: 'mamdouh',
      email: 'mamdouh1626@gmail.com',
      passwordHash: mamdouhHash,
      salt: mamdouhSalt,
      webauthnCredentialId: null
    },
    {
      username: 'guest',
      email: 'guest@mge.com',
      passwordHash: guestHash,
      salt: guestSalt,
      webauthnCredentialId: null
    },
    {
      username: 'mallea',
      email: 'mallea@retroplay.com',
      passwordHash: malleaHash,
      salt: malleaSalt,
      webauthnCredentialId: null
    }
  ],
  roms: [
    {
      id: 'rom_pre1',
      name: 'Galaxy Striker 1999 (محاكي فضاء ثلاثي الأبعاد)',
      size: 14502390,
      filename: 'galaxy_striker_1999.bin',
      uploadDate: new Date().toISOString(),
      console: 'PS1',
      preloaded: true
    },
    {
      id: 'rom_pre2',
      name: 'Formula Retro Racing (لعبة سباق سيارات كلاسيكية)',
      size: 18902422,
      filename: 'formula_retro_racing.bin',
      uploadDate: new Date().toISOString(),
      console: 'PS1',
      preloaded: true
    },
    {
      id: 'rom_pre3',
      name: 'Memory Card Manager (أداة تهيئة كروت الذاكرة)',
      size: 4501239,
      filename: 'memory_card_manager.bin',
      uploadDate: new Date().toISOString(),
      console: 'PS1',
      preloaded: true
    }
  ],
  saves: []
};

// Load database from disk
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      let raw = fs.readFileSync(DB_PATH, 'utf8');
      // Strip UTF-8 BOM if present
      if (raw.charCodeAt(0) === 0xFEFF) {
        raw = raw.slice(1);
      }
      const loaded = JSON.parse(raw);
      
      // Ensure tables exist
      dbData.saves = loaded.saves || [];
      dbData.users = loaded.users || dbData.users;
      dbData.system_config = loaded.system_config || { portal_name: "ألعاب الزمن الجميل" };
      dbData.local_apps = loaded.local_apps || [];
      
      // Ensure mallea user exists in loaded users
      const hasMallea = dbData.users.some(u => u.username.toLowerCase() === 'mallea');
      if (!hasMallea) {
        const malleaSalt = generateSalt();
        const malleaHash = hashPassword('mallea10@', malleaSalt);
        dbData.users.push({
          username: 'mallea',
          email: 'mallea@retroplay.com',
          passwordHash: malleaHash,
          salt: malleaSalt,
          webauthnCredentialId: null
        });
      }
      
      // Merge loaded roms, ensuring preloaded games are always present
      const loadedRoms = loaded.roms || [];
      const preloadedIds = ['rom_pre1', 'rom_pre2', 'rom_pre3'];
      const customRoms = loadedRoms.filter(r => !preloadedIds.includes(r.id));
      
      dbData.roms = [
        ...dbData.roms.filter(r => preloadedIds.includes(r.id)),
        ...customRoms
      ];
      
      saveDB();
    } else {
      saveDB();
    }
  } catch (err) {
    console.error("Failed to load local database, resetting data: ", err);
    saveDB();
  }
}

// Save database to disk
function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(dbData, null, 2), 'utf8');
  } catch (err) {
    console.error("Failed to save database to disk: ", err);
  }
}

// DB Methods
const db = {
  init() {
    loadDB();
  },

  // Users Table
  getUser(username) {
    if (!username) return null;
    const cleanUsername = username.trim().toLowerCase();
    return dbData.users.find(u => u.username && u.username.trim().toLowerCase() === cleanUsername);
  },

  // Securely Register User
  registerUser(username, email, password) {
    if (!username || !email || !password) {
      return { success: false, message: 'يرجى ملء جميع الحقول المطلوبة!' };
    }
    const cleanUsername = username.trim();
    const cleanEmail = email.trim();

    // Check if user already exists
    const existing = this.getUser(cleanUsername);
    if (existing) {
      return { success: false, message: 'اسم المستخدم مسجل بالفعل!' };
    }

    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);

    const newUser = {
      username: cleanUsername,
      email: cleanEmail,
      passwordHash: passwordHash,
      salt: salt,
      webauthnCredentialId: null
    };

    dbData.users.push(newUser);
    saveDB();
    return { success: true, user: newUser };
  },

  // Verify User Password
  verifyPassword(username, password) {
    const user = this.getUser(username);
    if (!user) return false;
    
    const checkHash = hashPassword(password, user.salt);
    return user.passwordHash === checkHash;
  },
  
  saveUserWebAuthn(username, credentialId) {
    const user = this.getUser(username);
    if (user) {
      user.webauthnCredentialId = credentialId;
      saveDB();
      return true;
    }
    return false;
  },

  changePassword(username, newPassword) {
    const user = this.getUser(username);
    if (user) {
      const salt = generateSalt();
      user.salt = salt;
      user.passwordHash = hashPassword(newPassword, salt);
      saveDB();
      return true;
    }
    return false;
  },

  // Roms Table
  getRoms() {
    return dbData.roms;
  },
  
  addRom(name, size, filename) {
    const newRom = {
      id: 'rom_' + Date.now() + Math.random().toString(36).substring(2, 5),
      name: name,
      size: size,
      filename: filename,
      uploadDate: new Date().toISOString(),
      console: 'PS1',
      preloaded: false
    };
    dbData.roms.push(newRom);
    saveDB();
    return newRom;
  },

  // Saves/Memory Card Table
  getSaves() {
    return dbData.saves;
  },

  addSave(game, score, slot) {
    dbData.saves = dbData.saves.filter(s => s.slot !== slot);

    const newSave = {
      id: 'save_' + Date.now() + Math.random().toString(36).substring(2, 5),
      game: game,
      score: score,
      slot: slot,
      date: new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' })
    };
    dbData.saves.push(newSave);
    saveDB();
    return newSave;
  },

  deleteSave(slot) {
    const originalLength = dbData.saves.length;
    dbData.saves = dbData.saves.filter(s => s.slot !== slot);
    saveDB();
    return dbData.saves.length < originalLength;
  },

  importSaves(savesArray) {
    if (!Array.isArray(savesArray)) return false;
    
    const validSaves = savesArray.filter(s => {
      return s && typeof s.game === 'string' && typeof s.score === 'number' && typeof s.slot === 'number';
    });
    
    validSaves.forEach(incoming => {
      dbData.saves = dbData.saves.filter(s => s.slot !== incoming.slot);
      dbData.saves.push({
        id: incoming.id || ('save_' + Date.now() + Math.random().toString(36).substring(2, 5)),
        game: incoming.game,
        score: incoming.score,
        slot: incoming.slot,
        date: incoming.date || new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' })
      });
    });
    
    saveDB();
    return true;
  },

  // Config & Admin helpers
  getUsers() {
    return dbData.users;
  },

  deleteUser(username) {
    const originalLength = dbData.users.length;
    dbData.users = dbData.users.filter(u => u.username.toLowerCase() !== username.toLowerCase());
    saveDB();
    return dbData.users.length < originalLength;
  },

  updateUser(username, newEmail, newPassword) {
    const user = this.getUser(username);
    if (user) {
      if (newEmail) user.email = newEmail.trim();
      if (newPassword) {
        const salt = generateSalt();
        user.salt = salt;
        user.passwordHash = hashPassword(newPassword, salt);
      }
      saveDB();
      return true;
    }
    return false;
  },

  getSystemConfig() {
    return dbData.system_config || { portal_name: "ألعاب الزمن الجميل" };
  },

  saveSystemConfig(config) {
    dbData.system_config = config;
    saveDB();
    return dbData.system_config;
  },

  getLocalApps() {
    return dbData.local_apps || [];
  },

  addLocalApp(name, packageName, icon, platform) {
    if (!dbData.local_apps) dbData.local_apps = [];
    const newApp = {
      id: 'local_app_' + Date.now() + Math.random().toString(36).substring(2, 5),
      name: name,
      package: packageName,
      icon: icon,
      platform: platform
    };
    dbData.local_apps.push(newApp);
    saveDB();
    return newApp;
  },

  deleteLocalApp(id) {
    if (!dbData.local_apps) return false;
    const originalLength = dbData.local_apps.length;
    dbData.local_apps = dbData.local_apps.filter(app => app.id !== id);
    saveDB();
    return dbData.local_apps.length < originalLength;
  }
};

module.exports = db;

