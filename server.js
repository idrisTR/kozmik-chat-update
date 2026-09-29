const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 24 * 1024 * 1024 // 15MB dosya, base64 olunca ~20MB eder
});

// ⚠️ ARTIK TÜM KLASÖR YAYINLANMIYOR: sadece index.html sunulur.
// (users.json ve server.js dışarıdan okunamaz)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ------------------------------------------------------------------ */
/*  KULLANICI VERİTABANI                                               */
/* ------------------------------------------------------------------ */
const USERS_FILE = path.join(__dirname, 'users.json');
const ROLE_RANK = { standard: 0, vip: 1, dev: 2, owner: 3 };
// 👑 KURUCU: en yüksek rütbe. Ban / susturma / rol değiştirme / silme işlemlerine tamamen kapalıdır.
// Birden fazla kurucu için: OWNER_USERS="idrisSX,baskaKisi"
const OWNER_USERS = (process.env.OWNER_USERS || 'idrisSX').split(',').map(s => s.trim()).filter(Boolean);
const isOwnerName = (name) => typeof name === 'string' && OWNER_USERS.some(o => o.toLowerCase() === name.toLowerCase());
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Kullanıcı verisi okuma hatası:', err);
    }
    return {};
}

function saveUsers(data) {
    try {
        const tmp = USERS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, USERS_FILE); // yarım yazılmış dosya riskini önler
    } catch (err) {
        console.error('Kullanıcı verisi kaydetme hatası:', err);
    }
}

const usersDb = loadUsers();

// Eski düz metin şifreleri açılışta otomatik hash'le
let migrated = 0;
for (const name of Object.keys(usersDb)) {
    const u = usersDb[name];
    if (typeof u.password === 'string') {
        u.passwordHash = bcrypt.hashSync(u.password, 10);
        delete u.password;
        migrated++;
    }
}
if (migrated > 0) {
    saveUsers(usersDb);
    console.log(`🔐 ${migrated} kullanıcının şifresi hash'lendi.`);
}

// Kurucu hesaplar her açılışta owner yapılır, ban/susturma kaldırılır (users.json elle bozulsa bile)
(function enforceOwners() {
    let changed = false;
    for (const name of Object.keys(usersDb)) {
        if (!isOwnerName(name)) continue;
        const u = usersDb[name];
        if (u.role !== 'owner' || u.isBanned || u.mutedUntil) {
            u.role = 'owner'; u.isBanned = false; delete u.mutedUntil;
            changed = true;
        }
    }
    if (changed) { saveUsers(usersDb); console.log('👑 Kurucu hesaplar güncellendi.'); }
})();

/* ------------------------------------------------------------------ */
/*  AYARLAR                                                            */
/* ------------------------------------------------------------------ */
// Kodları istersen ortam değişkeninden ver: NEPTUNE_CODES="a,b,c"
const VALID_NEPTUNE_CODES = (process.env.NEPTUNE_CODES || 'NEPTUN2026,7777,ADAMS9999,0000').split(',');
const VALID_JUPITER_CODES = (process.env.JUPITER_CODES || 'JUPITER999,DEV2026,IDRISDEV').split(',');
const VIP_NEPTUNE_CODES = ['ADAMS9999', '0000'];

const BAN_MESSAGE = '⛔ KOZMİK SINIR DIŞI EDİLDİNİZ! İtirazınız varsa: idrisefesakin992@gmail.com';

const RESTRICTED_ROOMS = ['Soğuk Dereceler', 'Büyük Kırmızı Leke']; // vip/dev gerekir
const roomHistory = {
    'Galle': [], 'Le Verrier': [], 'Lassell': [], 'Soğuk Dereceler': [],
    'Io': [], 'Europa': [], 'Ganymede': [], 'Büyük Kırmızı Leke': [],
    'Galaktik Konferans': []
};
const VOICE_ROOM = 'Galaktik Konferans';
const MAX_HISTORY = 100;
const MAX_MEDIA_PER_ROOM = 5; // RAM'i korumak için: eski medyalar silinir

const MEDIA_RE = /^data:(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|ogg));base64,[A-Za-z0-9+/=]+$/;
const USERNAME_RE = /^[A-Za-z0-9ğüşöçıİĞÜŞÖÇ_.\-]{3,20}$/;
const BLOCKED_NAMES = ['__proto__', 'constructor', 'prototype'];

const voiceRoomUsers = {}; // socketId -> { username, socketId }
const failedLogins = {};   // "ip|kullanıcı" -> { count, lockUntil }

/* ------------------------------------------------------------------ */
/*  KALICI MESAJLAR (rooms.json) VE OTURUMLAR (sessions.json)          */
/* ------------------------------------------------------------------ */
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSION_DAYS = 30;

function atomicWrite(file, data) {
    try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
        fs.renameSync(tmp, file);
    } catch (err) {
        console.error('Yazma hatası (' + path.basename(file) + '):', err);
    }
}

try {
    if (fs.existsSync(ROOMS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
        for (const r of Object.keys(roomHistory)) {
            if (Array.isArray(saved[r])) roomHistory[r] = saved[r].slice(-MAX_HISTORY);
        }
    }
} catch (err) {
    console.error('rooms.json okunamadı:', err);
}

const DMS_FILE = path.join(__dirname, 'dms.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');
let dmHistory = {};
let logs = [];
try { if (fs.existsSync(DMS_FILE)) dmHistory = JSON.parse(fs.readFileSync(DMS_FILE, 'utf8')); } catch (err) { console.error('dms.json okunamadı:', err); }
try { if (fs.existsSync(LOGS_FILE)) logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); } catch (err) { console.error('logs.json okunamadı:', err); }
// Eski mesajlara kimlik (id) ver
[...Object.values(roomHistory), ...Object.values(dmHistory)].forEach(h => h.forEach(m => { if (!m.id) m.id = crypto.randomUUID(); }));

let roomsDirty = false;
let logsDirty = false;
const markRoomsDirty = () => { roomsDirty = true; };
function addLog(type, actor, target, detail) {
    logs.push({ t: Date.now(), type, actor: actor || '', target: target || '', detail: detail || '' });
    if (logs.length > 500) logs.shift();
    logsDirty = true;
}
// Medya (büyük veri) diske yazılmaz, sadece metin saklanır
const stripMedia = (hist) => hist.map(m => m.mediaUrl
    ? { ...m, mediaUrl: undefined, mediaType: undefined, text: '🖼️ (medya kalıcı saklanmaz)' }
    : m);
function flushRooms() {
    if (roomsDirty) {
        roomsDirty = false;
        const rooms = {};
        for (const r of Object.keys(roomHistory)) rooms[r] = stripMedia(roomHistory[r]);
        atomicWrite(ROOMS_FILE, rooms);
        const dms = {};
        for (const k of Object.keys(dmHistory)) if (dmHistory[k].length) dms[k] = stripMedia(dmHistory[k]);
        atomicWrite(DMS_FILE, dms);
    }
    if (logsDirty) { logsDirty = false; atomicWrite(LOGS_FILE, logs); }
}
setInterval(flushRooms, 3000);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { flushRooms(); process.exit(0); }));

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
let sessions = {};
try {
    if (fs.existsSync(SESSIONS_FILE)) sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
} catch (err) {
    console.error('sessions.json okunamadı:', err);
}
(function pruneSessions() {
    const now = Date.now();
    for (const k of Object.keys(sessions)) {
        if (sessions[k].exp < now || !has(usersDb, sessions[k].username)) delete sessions[k];
    }
    atomicWrite(SESSIONS_FILE, sessions);
})();

function issueSession(username, planet) {
    const token = crypto.randomBytes(32).toString('hex'); // sunucuda sadece hash'i saklanır
    sessions[sha(token)] = {
        username,
        planet: planet === 'jupiter' ? 'jupiter' : 'neptune',
        exp: Date.now() + SESSION_DAYS * 86400000
    };
    atomicWrite(SESSIONS_FILE, sessions);
    return token;
}
function dropSessions(username) {
    for (const k of Object.keys(sessions)) if (sessions[k].username === username) delete sessions[k];
    atomicWrite(SESSIONS_FILE, sessions);
}

// Şifre doğrulama (yanlış denemeleri sınırlar)
async function checkPassword(socket, username, password) {
    const key = 'pw|' + socket.handshake.address + '|' + username.toLowerCase();
    const rec = failedLogins[key] || { count: 0, lockUntil: 0 };
    if (rec.lockUntil > Date.now()) return 'locked';
    const ok = typeof password === 'string' && await bcrypt.compare(password, usersDb[username].passwordHash);
    if (!ok) {
        rec.count++;
        if (rec.count >= 5) { rec.lockUntil = Date.now() + 60000; rec.count = 0; }
        failedLogins[key] = rec;
        return 'wrong';
    }
    delete failedLogins[key];
    return 'ok';
}

/* ------------------------------------------------------------------ */
/*  YARDIMCILAR                                                        */
/* ------------------------------------------------------------------ */
function getUser(socket) {
    const name = socket.data.username;
    return name && has(usersDb, name) ? usersDb[name] : null;
}
function getRank(user) { return user ? ROLE_RANK[user.role] ?? 0 : 0; }

const isDmKey = (r) => typeof r === 'string' && r.startsWith('dm:');
const dmKey = (a, b) => 'dm:' + [a.toLowerCase(), b.toLowerCase()].sort().join('|');
function getHistory(room) {
    if (has(roomHistory, room)) return roomHistory[room];
    if (!has(dmHistory, room)) dmHistory[room] = [];
    return dmHistory[room];
}
function findUsername(lower) {
    return Object.keys(usersDb).find(n => n.toLowerCase() === String(lower).toLowerCase()) || null;
}

function canEnterRoom(user, roomName, username) {
    if (isDmKey(roomName)) {
        const parts = roomName.slice(3).split('|');
        return parts.length === 2 && !!username && parts.includes(username.toLowerCase());
    }
    if (!has(roomHistory, roomName)) return false;
    if (RESTRICTED_ROOMS.includes(roomName)) return getRank(user) >= 1;
    return true;
}

function trimMedia(room) {
    const hist = getHistory(room);
    let mediaSeen = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].mediaUrl) {
            mediaSeen++;
            if (mediaSeen > MAX_MEDIA_PER_ROOM) {
                delete hist[i].mediaUrl;
                delete hist[i].mediaType;
                hist[i].text = '🗑️ (eski medya silindi)';
            }
        }
    }
}

const msgTimes = {}; // socketId -> zaman damgaları (rate limit)
function rateLimited(socketId, max = 6, windowMs = 4000) {
    const now = Date.now();
    const arr = (msgTimes[socketId] = (msgTimes[socketId] || []).filter(t => now - t < windowMs));
    if (arr.length >= max) return true;
    arr.push(now);
    return false;
}

function broadcastUserCounts() {
    const roomCounts = {};
    Object.keys(roomHistory).forEach(r => (roomCounts[r] = 0));
    let globalCount = 0;
    for (const [, s] of io.sockets.sockets) {
        globalCount++;
        const r = s.data.room;
        if (r && has(roomCounts, r)) roomCounts[r]++;
    }
    io.emit('update-user-counts', { globalCount, roomCounts });
}

function leaveCurrentRoom(socket) {
    const oldRoom = socket.data.room;
    if (!oldRoom) return;
    socket.leave(oldRoom);
    socket.to(oldRoom).emit('user-stop-typing', { socketId: socket.id });
    if (voiceRoomUsers[socket.id]) {
        delete voiceRoomUsers[socket.id];
        socket.to(oldRoom).emit('voice-user-left', { socketId: socket.id });
    }
}

function broadcastOnline() {
    const map = {};
    for (const [, s] of io.sockets.sockets) {
        const n = s.data.username;
        if (n && has(usersDb, n)) map[n] = usersDb[n].role;
    }
    const list = Object.keys(map).sort((a, b) => a.localeCompare(b, 'tr')).map(u => ({ username: u, role: map[u] }));
    for (const [, s] of io.sockets.sockets) if (s.data.username) s.emit('online-users', list);
}

function notifyDm(room, senderName, msg) {
    const parts = room.slice(3).split('|');
    const partnerLower = parts[0] === senderName.toLowerCase() ? parts[1] : parts[0];
    for (const [, s] of io.sockets.sockets) {
        if (s.data.username && s.data.username.toLowerCase() === partnerLower && s.data.room !== room) {
            s.emit('dm-notify', { from: senderName, text: (msg.text || '').slice(0, 60) });
        }
    }
}

function kickBanned(username) {
    if (isOwnerName(username)) return;
    for (const [, s] of io.sockets.sockets) {
        if (s.data.username === username) {
            s.emit('kicked-banned', { message: BAN_MESSAGE });
            s.data.username = null; // artık hiçbir işlem yapamaz
        }
    }
    broadcastOnline();
}

/* ------------------------------------------------------------------ */
/*  SOCKET                                                             */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
    socket.data = { username: null, room: null, pendingRole: null };
    broadcastUserCounts();

    // 1) Frekans kodu → rolü SUNUCU belirler
    socket.on('verify-passcode', (data, callback) => {
        if (typeof callback !== 'function') return;
        const planet = data && data.planet;
        const code = data && String(data.code);
        let role = null;

        if (planet === 'neptune' && VALID_NEPTUNE_CODES.includes(code)) {
            role = VIP_NEPTUNE_CODES.includes(code) ? 'vip' : 'standard';
        } else if (planet === 'jupiter' && VALID_JUPITER_CODES.includes(code)) {
            role = 'dev';
        }

        if (!role) {
            return callback({ success: false, message: '⚠️ HATALI FREKANS KODU! ERİŞİM REDDEDİLDİ.' });
        }
        socket.data.pendingRole = role; // kayıt sırasında bu kullanılacak
        socket.data.planet = planet;
        callback({ success: true, defaultRole: role });
    });

    // 2) Kayıt → istemcinin gönderdiği defaultRole ARTIK YOK SAYILIR
    socket.on('auth-register', async (data, callback) => {
        if (typeof callback !== 'function') return;
        try {
            const { username, password, confirmPassword } = data || {};

            if (!socket.data.pendingRole) {
                return callback({ success: false, message: 'Önce frekans kodunu doğrulamalısın!' });
            }
            if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
                return callback({ success: false, message: 'Lütfen tüm alanları doldurun!' });
            }
            if (!USERNAME_RE.test(username) || BLOCKED_NAMES.includes(username.toLowerCase())) {
                return callback({ success: false, message: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ . - ).' });
            }
            if (password.length < 6 || password.length > 72) {
                return callback({ success: false, message: 'Şifre en az 6 karakter olmalı!' });
            }
            if (password !== confirmPassword) {
                return callback({ success: false, message: 'Şifreler birbiriyle eşleşmiyor!' });
            }
            if (isOwnerName(username)) {
                return callback({ success: false, message: 'Bu kullanıcı adı ayrılmış!' });
            }
            const lower = username.toLowerCase();
            if (Object.keys(usersDb).some(n => n.toLowerCase() === lower)) {
                return callback({ success: false, message: 'Bu kullanıcı adı zaten alınmış!' });
            }

            const role = socket.data.pendingRole;
            usersDb[username] = {
                passwordHash: await bcrypt.hash(password, 10),
                role,
                isBanned: false
            };
            saveUsers(usersDb);

            socket.data.username = username;
            socket.data.pendingRole = null;
            addLog('register', username, '', role);
            broadcastOnline();
            callback({ success: true, token: issueSession(username, socket.data.planet), user: { username, role, isBanned: false } });
        } catch (err) {
            console.error('Kayıt hatası:', err);
            callback({ success: false, message: 'Sunucu hatası.' });
        }
    });

    // 3) Giriş → deneme sınırı + hash kontrolü
    socket.on('auth-login', async (data, callback) => {
        if (typeof callback !== 'function') return;
        try {
            const { username, password } = data || {};
            if (typeof username !== 'string' || typeof password !== 'string') {
                return callback({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' });
            }

            const key = socket.handshake.address + '|' + username.toLowerCase();
            const rec = failedLogins[key] || { count: 0, lockUntil: 0 };
            if (rec.lockUntil > Date.now()) {
                return callback({ success: false, message: 'Çok fazla deneme! 1 dakika sonra tekrar dene.' });
            }

            const user = has(usersDb, username) ? usersDb[username] : null;
            const ok = user && await bcrypt.compare(password, user.passwordHash);

            if (!ok) {
                rec.count++;
                if (rec.count >= 5) { rec.lockUntil = Date.now() + 60000; rec.count = 0; addLog('lockout', '', username, 'ip: ' + socket.handshake.address); }
                failedLogins[key] = rec;
                return callback({ success: false, message: 'Hatalı kullanıcı adı veya şifre!' });
            }
            delete failedLogins[key];

            if (user.isBanned) {
                return callback({ success: false, isBanned: true, message: BAN_MESSAGE });
            }

            socket.data.username = username;
            addLog('login', username);
            broadcastOnline();
            callback({ success: true, token: issueSession(username, socket.data.planet), user: { username, role: user.role, isBanned: false } });
        } catch (err) {
            console.error('Giriş hatası:', err);
            callback({ success: false, message: 'Sunucu hatası.' });
        }
    });

    // 4) Odaya katılma → giriş şart, VIP odaları sunucuda kontrol edilir
    socket.on('join-room', (data) => {
        const user = getUser(socket);
        if (!user || user.isBanned) return;

        const roomName = typeof data === 'object' && data ? data.room : data;
        if (typeof roomName !== 'string' || isDmKey(roomName) || !canEnterRoom(user, roomName, socket.data.username)) return;

        leaveCurrentRoom(socket); // istemciye güvenme, sunucudaki kaydı kullan

        socket.join(roomName);
        socket.data.room = roomName;
        socket.emit('room-history', { room: roomName, history: roomHistory[roomName] });
        broadcastUserCounts();
    });

    // 5) Mesaj → gönderen ve rol bilgisi SUNUCUDAN gelir
    socket.on('send-message', (data) => {
        const user = getUser(socket);
        if (!user || !data || typeof data !== 'object') return;
        if (user.isBanned) {
            socket.emit('kicked-banned', { message: BAN_MESSAGE });
            return;
        }
        const room = socket.data.room;
        if (!room || data.room !== room || !canEnterRoom(user, room, socket.data.username)) return;
        if (user.mutedUntil && user.mutedUntil > Date.now()) {
            const left = Math.ceil((user.mutedUntil - Date.now()) / 60000);
            socket.emit('system-notice', { message: '🔇 Susturuldun. Kalan süre: ' + left + ' dk.' });
            return;
        }
        if (rateLimited(socket.id)) return;

        const text = typeof data.text === 'string' ? data.text.slice(0, 1000) : '';
        if (!text.trim()) return;

        const msg = {
            id: crypto.randomUUID(),
            room,
            sender: socket.data.username,
            text,
            isVip: user.role === 'vip',
            isDev: user.role === 'dev',
            isOwner: user.role === 'owner',
            time: typeof data.time === 'string' ? data.time.slice(0, 8) : '',
            replyTo: null
        };

        if (data.replyTo && typeof data.replyTo === 'object') {
            msg.replyTo = {
                sender: String(data.replyTo.sender || '').slice(0, 20),
                text: String(data.replyTo.text || '').slice(0, 200)
            };
        }

        if (data.mediaUrl) {
            if (typeof data.mediaUrl !== 'string' || !MEDIA_RE.test(data.mediaUrl)) return;
            msg.mediaUrl = data.mediaUrl;
            msg.mediaType = data.mediaUrl.startsWith('data:image/') ? 'image' : 'video';
        }

        const hist = getHistory(room);
        hist.push(msg);
        if (hist.length > MAX_HISTORY) hist.shift();
        if (msg.mediaUrl) trimMedia(room);
        markRoomsDirty();

        io.to(room).emit('receive-message', msg);
        if (isDmKey(room)) notifyDm(room, socket.data.username, msg);
        socket.to(room).emit('user-stop-typing', { socketId: socket.id });
    });

    socket.on('typing', () => {
        const room = socket.data.room;
        if (room && socket.data.username) {
            socket.to(room).emit('user-typing', { sender: socket.data.username, socketId: socket.id });
        }
    });

    socket.on('stop-typing', () => {
        const room = socket.data.room;
        if (room) socket.to(room).emit('user-stop-typing', { socketId: socket.id });
    });

    // Oturum hatırlama
    socket.on('auth-resume', (data, callback) => {
        if (typeof callback !== 'function') return;
        const token = data && typeof data.token === 'string' ? data.token : '';
        const sess = token ? sessions[sha(token)] : null;
        if (!sess || sess.exp < Date.now() || !has(usersDb, sess.username)) return callback({ success: false });
        const user = usersDb[sess.username];
        if (user.isBanned) return callback({ success: false, isBanned: true, message: BAN_MESSAGE });
        socket.data.username = sess.username;
        socket.data.planet = sess.planet;
        broadcastOnline();
        callback({ success: true, planet: sess.planet, user: { username: sess.username, role: user.role, isBanned: false } });
    });

    socket.on('auth-logout', (data) => {
        const token = data && typeof data.token === 'string' ? data.token : '';
        if (token && sessions[sha(token)]) { delete sessions[sha(token)]; atomicWrite(SESSIONS_FILE, sessions); }
        if (socket.data.room) socket.leave(socket.data.room);
        socket.data.username = null;
        socket.data.room = null;
        broadcastUserCounts();
        broadcastOnline();
    });

    // Şifre değiştirme (tüm eski oturumlar kapanır, yeni token döner)
    socket.on('auth-change-password', async (data, callback) => {
        if (typeof callback !== 'function') return;
        try {
            const user = getUser(socket);
            if (!user) return callback({ success: false, message: 'Giriş yapmalısın.' });
            const { oldPassword, newPassword } = data || {};
            if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 72) {
                return callback({ success: false, message: 'Yeni şifre en az 6 karakter olmalı!' });
            }
            const chk = await checkPassword(socket, socket.data.username, oldPassword);
            if (chk === 'locked') return callback({ success: false, message: 'Çok fazla deneme! 1 dakika bekle.' });
            if (chk !== 'ok') return callback({ success: false, message: 'Mevcut şifre yanlış!' });

            user.passwordHash = await bcrypt.hash(newPassword, 10);
            saveUsers(usersDb);
            dropSessions(socket.data.username);
            addLog('password', socket.data.username);
            callback({ success: true, token: issueSession(socket.data.username, socket.data.planet) });
        } catch (err) {
            console.error('Şifre değiştirme hatası:', err);
            callback({ success: false, message: 'Sunucu hatası.' });
        }
    });

    // Hesap silme
    socket.on('auth-delete-account', async (data, callback) => {
        if (typeof callback !== 'function') return;
        try {
            const user = getUser(socket);
            if (!user) return callback({ success: false, message: 'Giriş yapmalısın.' });
            const name = socket.data.username;
            if (isOwnerName(name) || user.role === 'owner') {
                return callback({ success: false, message: '👑 Kurucu hesap silinemez.' });
            }
            const chk = await checkPassword(socket, name, data && data.password);
            if (chk === 'locked') return callback({ success: false, message: 'Çok fazla deneme! 1 dakika bekle.' });
            if (chk !== 'ok') return callback({ success: false, message: 'Şifre yanlış!' });

            delete usersDb[name];
            saveUsers(usersDb);
            dropSessions(name);
            for (const [, s] of io.sockets.sockets) {
                if (s.data.username === name && s.id !== socket.id) {
                    s.emit('kicked-banned', { message: 'Hesabın silindi.' });
                    s.data.username = null;
                }
            }
            socket.data.username = null;
            addLog('delete-account', name);
            broadcastOnline();
            callback({ success: true });
        } catch (err) {
            console.error('Hesap silme hatası:', err);
            callback({ success: false, message: 'Sunucu hatası.' });
        }
    });

    /* ---------------- WEBRTC (sadece Galaktik Konferans) ---------------- */
    socket.on('voice-join', () => {
        if (!getUser(socket) || socket.data.room !== VOICE_ROOM) return;
        voiceRoomUsers[socket.id] = { username: socket.data.username, socketId: socket.id };

        const others = Object.values(voiceRoomUsers).filter(u => u.socketId !== socket.id);
        socket.emit('voice-all-users', others);
        socket.to(VOICE_ROOM).emit('voice-user-joined', { socketId: socket.id, username: socket.data.username });
    });

    socket.on('voice-signal', (data) => {
        if (!data || !voiceRoomUsers[socket.id] || !voiceRoomUsers[data.targetSocketId]) return;
        io.to(data.targetSocketId).emit('voice-signal', { senderSocketId: socket.id, signal: data.signal });
    });

    socket.on('voice-leave', () => {
        if (voiceRoomUsers[socket.id]) {
            delete voiceRoomUsers[socket.id];
            socket.to(VOICE_ROOM).emit('voice-user-left', { socketId: socket.id });
        }
    });

    /* ---------------- ADMİN PANEL (yetki kontrollü) ---------------- */
    // Kural: kendinden DÜŞÜK rütbeli kullanıcıları yönetebilirsin.
    // vip → standard'ları yönetir, dev → vip ve standard'ları yönetir.
    function protectOwner(targetName, callback) {
        if (isOwnerName(targetName) || (has(usersDb, targetName) && usersDb[targetName].role === 'owner')) {
            callback({ success: false, message: '👑 Kurucuya dokunulamaz.' });
            return true;
        }
        return false;
    }
    function adminActor(callback) {
        const actor = getUser(socket);
        if (!actor || actor.isBanned || getRank(actor) < 1) {
            callback({ success: false, message: 'Yetkin yok.' });
            return null;
        }
        return actor;
    }

    socket.on('admin-get-users', (callback) => {
        if (typeof callback !== 'function' || !adminActor(callback)) return;
        const users = Object.keys(usersDb).map(u => ({
            username: u, role: usersDb[u].role, isBanned: usersDb[u].isBanned || false,
            mutedUntil: usersDb[u].mutedUntil || 0
        }));
        callback({ success: true, users });
    });

    socket.on('admin-update-role', (data, callback) => {
        if (typeof callback !== 'function') return;
        const actor = adminActor(callback);
        if (!actor) return;

        const { targetUsername, newRole } = data || {};
        if (typeof targetUsername !== 'string' || !has(usersDb, targetUsername)) {
            return callback({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        if (!has(ROLE_RANK, newRole) || newRole === 'owner') {
            return callback({ success: false, message: 'Geçersiz rol.' });
        }
        if (protectOwner(targetUsername, callback)) return;
        const target = usersDb[targetUsername];
        if (getRank(target) >= getRank(actor) || ROLE_RANK[newRole] > getRank(actor)) {
            return callback({ success: false, message: 'Bu işlem için yetkin yetmiyor.' });
        }

        target.role = newRole;
        saveUsers(usersDb);
        addLog('role', socket.data.username, targetUsername, newRole);
        broadcastOnline();
        callback({ success: true });
    });

    socket.on('admin-toggle-ban', (data, callback) => {
        if (typeof callback !== 'function') return;
        const actor = adminActor(callback);
        if (!actor) return;

        const { targetUsername } = data || {};
        if (typeof targetUsername !== 'string' || !has(usersDb, targetUsername)) {
            return callback({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        if (protectOwner(targetUsername, callback)) return;
        const target = usersDb[targetUsername];
        if (getRank(target) >= getRank(actor)) {
            return callback({ success: false, message: 'Bu işlem için yetkin yetmiyor.' });
        }

        target.isBanned = !target.isBanned;
        saveUsers(usersDb);
        addLog(target.isBanned ? 'ban' : 'unban', socket.data.username, targetUsername);
        if (target.isBanned) kickBanned(targetUsername);
        callback({ success: true, isBanned: target.isBanned });
    });

    socket.on('admin-mute', (data, callback) => {
        if (typeof callback !== 'function') return;
        const actor = adminActor(callback);
        if (!actor) return;
        const { targetUsername, minutes } = data || {};
        if (typeof targetUsername !== 'string' || !has(usersDb, targetUsername)) {
            return callback({ success: false, message: 'Kullanıcı bulunamadı.' });
        }
        if (protectOwner(targetUsername, callback)) return;
        const target = usersDb[targetUsername];
        if (getRank(target) >= getRank(actor)) {
            return callback({ success: false, message: 'Bu işlem için yetkin yetmiyor.' });
        }
        const mins = Math.max(0, Math.min(Number(minutes) || 0, 60 * 24 * 30));
        if (mins > 0) target.mutedUntil = Date.now() + mins * 60000;
        else delete target.mutedUntil;
        saveUsers(usersDb);
        addLog(mins > 0 ? 'mute' : 'unmute', socket.data.username, targetUsername, mins > 0 ? mins + ' dk' : '');
        callback({ success: true, mutedUntil: target.mutedUntil || 0 });
    });

    socket.on('admin-get-logs', (callback) => {
        if (typeof callback !== 'function' || !adminActor(callback)) return;
        callback({ success: true, logs: logs.slice(-200).reverse() });
    });

    /* ---------------- ÖZEL MESAJ ve MESAJ SİLME ---------------- */
    socket.on('dm-open', (data, callback) => {
        if (typeof callback !== 'function') return;
        const user = getUser(socket);
        if (!user || user.isBanned) return callback({ success: false, message: 'Giriş yapmalısın.' });
        const target = data && typeof data.target === 'string' ? findUsername(data.target) : null;
        if (!target) return callback({ success: false, message: 'Kullanıcı bulunamadı.' });
        if (target.toLowerCase() === socket.data.username.toLowerCase()) {
            return callback({ success: false, message: 'Kendine mesaj atamazsın.' });
        }
        const key = dmKey(socket.data.username, target);
        leaveCurrentRoom(socket);
        socket.join(key);
        socket.data.room = key;
        callback({ success: true, room: key, title: target });
        socket.emit('room-history', { room: key, history: getHistory(key) });
        broadcastUserCounts();
    });

    socket.on('dm-list', (callback) => {
        if (typeof callback !== 'function' || !getUser(socket)) return;
        const me = socket.data.username.toLowerCase();
        const list = [];
        for (const key of Object.keys(dmHistory)) {
            const parts = key.slice(3).split('|');
            const hist = dmHistory[key];
            if (!parts.includes(me) || !hist.length) continue;
            const other = findUsername(parts[0] === me ? parts[1] : parts[0]);
            if (!other) continue;
            const last = hist[hist.length - 1];
            list.push({ username: other, last: (last.text || '').slice(0, 40), lastFrom: last.sender });
        }
        callback({ success: true, list: list.slice(-30) });
    });

    socket.on('delete-message', (data) => {
        const user = getUser(socket);
        if (!user || user.isBanned || !data || typeof data.id !== 'string') return;
        const room = socket.data.room;
        if (!room || data.room !== room) return;
        const hist = getHistory(room);
        const idx = hist.findIndex(m => m.id === data.id);
        if (idx < 0) return;
        const msg = hist[idx];
        const own = msg.sender === socket.data.username;
        let allowed = own;
        if (!allowed && !isDmKey(room)) { // özel mesajlara moderatör müdahale etmez
            const senderUser = has(usersDb, msg.sender) ? usersDb[msg.sender] : null;
            allowed = getRank(user) >= 1 && getRank(user) > getRank(senderUser);
        }
        if (!allowed) return;
        hist.splice(idx, 1);
        markRoomsDirty();
        if (!own) addLog('delete-msg', socket.data.username, msg.sender, room + ': ' + (msg.text || '').slice(0, 60));
        io.to(room).emit('message-deleted', { room, id: data.id });
    });

    socket.on('disconnect', () => {
        if (voiceRoomUsers[socket.id]) {
            delete voiceRoomUsers[socket.id];
            if (socket.data.room) socket.to(socket.data.room).emit('voice-user-left', { socketId: socket.id });
        }
        delete msgTimes[socket.id];
        broadcastUserCounts();
        broadcastOnline();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu http://localhost:${PORT} adresinde aktif!`);
});
