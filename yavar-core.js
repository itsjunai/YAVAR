/**
 * YAVAR — Gyroscopic Stability System
 * Pi Core v1.0.0 — Maritime Navigation
 *
 * Single-file Node.js server for Raspberry Pi.
 * Reads MPU-9250 via I2C, applies complementary filter,
 * broadcasts live gyro data over WebSocket.
 * Falls back to simulation if no hardware detected.
 *
 * Usage:
 *   node yavar-core.js
 *
 * Requirements:
 *   npm install express ws i2c-bus
 *
 * Hardware:
 *   MPU-9250 → Raspberry Pi 4
 *   VCC  → Pin 1  (3.3V)
 *   GND  → Pin 6  (GND)
 *   SDA  → Pin 3  (GPIO 2)
 *   SCL  → Pin 5  (GPIO 3)
 *
 * Enable I2C:
 *   sudo raspi-config nonint do_i2c 0
 *
 * Install as service:
 *   sudo systemctl enable yavar
 *   sudo systemctl start yavar
 */

'use strict';

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const crypto  = require('crypto');
const path    = require('path');
const os      = require('os');

/* ══════════════════════════════════════════
   CONFIGURATION
══════════════════════════════════════════ */
const CONFIG = {
  port:    3000,
  version: '1.0.0',
  imu: {
    bus:        1,
    address:    0x68,
    sampleRate: 100,   // Hz
    filterAlpha: 0.96, // complementary filter weight
  },
  credentials: {
    MASTER:   { pass: 'YAVAR2025', role: 'master'   },
    OPERATOR: { pass: 'HELM001',   role: 'operator' },
    GUEST:    { pass: 'MARITIME',  role: 'guest'    },
  },
  session: {
    ttl: 8 * 60 * 60 * 1000, // 8 hours
  },
};

/* ══════════════════════════════════════════
   LOGGER
══════════════════════════════════════════ */
const LOG = [];
const MAX_LOG = 500;

function pad(n) { return String(n).padStart(2, '0'); }
function utcStamp() {
  const d = new Date();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
function log(cat, msg) {
  const entry = { ts: utcStamp(), epoch: Date.now(), category: cat, message: msg };
  LOG.unshift(entry);
  if (LOG.length > MAX_LOG) LOG.pop();
  console.log(`[${entry.ts}] [${cat.padEnd(5)}] ${msg}`);
}

/* ══════════════════════════════════════════
   AUTH
══════════════════════════════════════════ */
const TOKENS = new Map();

function authVerify(user, pass) {
  const u = (user || '').trim().toUpperCase();
  const cred = CONFIG.credentials[u];
  if (cred && cred.pass === pass) {
    const token = crypto.randomBytes(24).toString('hex');
    TOKENS.set(token, { user: u, role: cred.role, ts: Date.now() });
    return { ok: true, role: cred.role, token };
  }
  return { ok: false };
}

function authRevoke(token) {
  TOKENS.delete(token);
}

/* ══════════════════════════════════════════
   MPU-9250 DRIVER
══════════════════════════════════════════ */
const MPU_ADDR     = CONFIG.imu.address;
const REG_PWR_MGMT = 0x6B;
const REG_ACCEL_CFG= 0x1C;
const REG_GYRO_CFG = 0x1B;
const REG_ACCEL_OUT= 0x3B;
const REG_TEMP_OUT = 0x41;
const REG_GYRO_OUT = 0x43;
const REG_WHO_AM_I = 0x75;

const ACCEL_SCALE = 9.80665 / 16384.0; // ±2g → m/s²
const GYRO_SCALE  = 1.0 / 131.0;       // ±250°/s → °/s

function s16(buf, off) {
  const v = (buf[off] << 8) | buf[off + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}

/* ══════════════════════════════════════════
   COMPLEMENTARY FILTER
══════════════════════════════════════════ */
let _roll = 0, _pitch = 0, _lastTs = null;
const ALPHA = CONFIG.imu.filterAlpha;

function complementaryFilter(ax, ay, az, gx, gy, dt) {
  const accelRoll  = Math.atan2(ay, az) * (180 / Math.PI);
  const accelPitch = Math.atan2(-ax, Math.sqrt(ay * ay + az * az)) * (180 / Math.PI);
  _roll  = ALPHA * (_roll  + gx * dt) + (1 - ALPHA) * accelRoll;
  _pitch = ALPHA * (_pitch + gy * dt) + (1 - ALPHA) * accelPitch;
  return {
    roll:  parseFloat(_roll.toFixed(3)),
    pitch: parseFloat(_pitch.toFixed(3)),
  };
}

/* ══════════════════════════════════════════
   IMU INIT — hardware then simulation
══════════════════════════════════════════ */
let _imuStatus = 'uninitialised';
let _imuMode   = 'simulation';
let _imuInterval = null;
let _simT = 0;

async function initIMU(onData) {
  log('IMU', 'Initialising MPU-9250...');

  try {
    const i2c = require('i2c-bus');
    const bus = await i2c.openPromisified(CONFIG.imu.bus);

    // Wake up
    await bus.writeByte(MPU_ADDR, REG_PWR_MGMT, 0x00);
    await new Promise(r => setTimeout(r, 150));

    // Verify WHO_AM_I
    const whoAmI = await bus.readByte(MPU_ADDR, REG_WHO_AM_I);
    if (whoAmI !== 0x71 && whoAmI !== 0x73 && whoAmI !== 0x70) {
      throw new Error(`WHO_AM_I mismatch: 0x${whoAmI.toString(16)}`);
    }

    // Set ±250°/s gyro, ±2g accel
    await bus.writeByte(MPU_ADDR, REG_GYRO_CFG,  0x00);
    await bus.writeByte(MPU_ADDR, REG_ACCEL_CFG, 0x00);

    _imuMode   = 'hardware';
    _imuStatus = 'online';
    log('IMU', `MPU-9250 online — WHO_AM_I 0x${whoAmI.toString(16)} — ${CONFIG.imu.sampleRate}Hz`);

    const hz  = CONFIG.imu.sampleRate;
    const aBuf = Buffer.alloc(6);
    const gBuf = Buffer.alloc(6);
    const tBuf = Buffer.alloc(2);

    _imuInterval = setInterval(async () => {
      try {
        const now = Date.now();
        const dt  = _lastTs ? (now - _lastTs) / 1000 : 1 / hz;
        _lastTs   = now;

        await bus.readI2cBlock(MPU_ADDR, REG_ACCEL_OUT, 6, aBuf);
        await bus.readI2cBlock(MPU_ADDR, REG_TEMP_OUT,  2, tBuf);
        await bus.readI2cBlock(MPU_ADDR, REG_GYRO_OUT,  6, gBuf);

        const ax = s16(aBuf, 0) * ACCEL_SCALE;
        const ay = s16(aBuf, 2) * ACCEL_SCALE;
        const az = s16(aBuf, 4) * ACCEL_SCALE;
        const gx = s16(gBuf, 0) * GYRO_SCALE;
        const gy = s16(gBuf, 2) * GYRO_SCALE;
        const rawTemp = s16(tBuf, 0);
        const temp = parseFloat((rawTemp / 340.0 + 36.53).toFixed(2));

        const { roll, pitch } = complementaryFilter(ax, ay, az, gx, gy, dt);

        onData({
          roll, pitch,
          heading: null, // AK8963 magnetometer — calibrate separately
          accelX:  parseFloat(ax.toFixed(4)),
          accelY:  parseFloat(ay.toFixed(4)),
          accelZ:  parseFloat(az.toFixed(4)),
          temp,
          ts: now,
        });
      } catch (err) {
        log('IMU', `Read error: ${err.message}`);
      }
    }, 1000 / hz);

  } catch (err) {
    log('IMU', `Hardware not found (${err.message}) — switching to simulation`);
    _imuMode   = 'simulation';
    _imuStatus = 'simulation';

    _imuInterval = setInterval(() => {
      _simT += 0.05;
      onData({
        roll:    parseFloat((Math.sin(_simT * 0.7) * 8 + Math.sin(_simT * 1.3) * 3).toFixed(3)),
        pitch:   parseFloat((Math.cos(_simT * 0.5) * 6 + Math.sin(_simT * 0.9) * 2).toFixed(3)),
        heading: parseFloat(((_simT * 3) % 360).toFixed(2)),
        accelX:  parseFloat((Math.sin(_simT) * 0.12).toFixed(4)),
        accelY:  parseFloat((Math.cos(_simT) * 0.12).toFixed(4)),
        accelZ:  9.81,
        temp:    parseFloat((22 + Math.sin(_simT * 0.08) * 1.5).toFixed(2)),
        ts:      Date.now(),
      });
    }, 1000 / CONFIG.imu.sampleRate);
  }
}

/* ══════════════════════════════════════════
   CALIBRATION
══════════════════════════════════════════ */
let calibration = { offX: 0, offY: 0, count: 0, last: null };

/* ══════════════════════════════════════════
   EXPRESS + WEBSOCKET SERVER
══════════════════════════════════════════ */
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());

// Serve YAVAR.html from same directory as this file
app.use(express.static(path.dirname(process.argv[1])));
app.get('/', (req, res) => {
  res.sendFile(path.join(path.dirname(process.argv[1]), 'YAVAR.html'));
});

/* ── REST API ── */
app.post('/api/auth', (req, res) => {
  const { user, pass } = req.body || {};
  const result = authVerify(user, pass);
  if (result.ok) {
    log('AUTH', `Authenticated: ${user.toUpperCase()}`);
    res.json(result);
  } else {
    log('AUTH', `Failed: ${user}`);
    res.status(401).json({ ok: false, message: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (token) authRevoke(token);
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => res.json(LOG));
app.delete('/api/log', (req, res) => { LOG.length = 0; res.json({ ok: true }); });

app.get('/api/calibration', (req, res) => res.json(calibration));

app.post('/api/calibration/set', (req, res) => {
  const { offX, offY } = req.body || {};
  calibration.offX  = parseFloat(offX) || 0;
  calibration.offY  = parseFloat(offY) || 0;
  calibration.count++;
  calibration.last  = utcStamp();
  log('CAL', `Zero-point: offX=${calibration.offX.toFixed(2)}° offY=${calibration.offY.toFixed(2)}°`);
  res.json({ ok: true, calibration });
});

app.post('/api/calibration/reset', (req, res) => {
  calibration = { offX: 0, offY: 0, count: 0, last: null };
  log('CAL', 'Reset to factory defaults');
  res.json({ ok: true, calibration });
});

app.get('/api/system', (req, res) => {
  res.json({
    version:  CONFIG.version,
    hostname: os.hostname(),
    platform: os.platform(),
    arch:     os.arch(),
    uptime:   Math.floor(os.uptime()),
    freemem:  os.freemem(),
    totalmem: os.totalmem(),
    imu:      { mode: _imuMode, status: _imuStatus, sensor: _imuMode === 'hardware' ? 'MPU-9250' : 'Simulation' },
  });
});

/* ── WEBSOCKET ── */
const clients = new Set();

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log('NET', `Client connected: ${req.socket.remoteAddress}`);

  // Send hello with IMU status and current calibration
  ws.send(JSON.stringify({
    type: 'hello',
    version: CONFIG.version,
    imu: { mode: _imuMode, status: _imuStatus },
    calibration,
  }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    } catch (_) {}
  });

  ws.on('close', ()  => { clients.delete(ws); });
  ws.on('error', ()  => { clients.delete(ws); });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

/* ── IMU → BROADCAST ── */
initIMU(data => {
  const corrected = {
    roll:    parseFloat((data.roll    - calibration.offX).toFixed(3)),
    pitch:   parseFloat((data.pitch   - calibration.offY).toFixed(3)),
    heading: data.heading != null ? parseFloat(data.heading.toFixed(2)) : null,
    accelX:  data.accelX,
    accelY:  data.accelY,
    accelZ:  data.accelZ,
    temp:    data.temp,
    ts:      data.ts,
  };
  broadcast({ type: 'gyro', data: corrected });
});

/* ── START ── */
server.listen(CONFIG.port, '0.0.0.0', () => {
  log('SYS', `YAVAR v${CONFIG.version} running`);
  log('SYS', `Local:   http://localhost:${CONFIG.port}`);
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) {
        log('SYS', `Network: http://${net.address}:${CONFIG.port}`);
      }
    }
  }
  log('SYS', 'Place YAVAR.html in the same directory as this file');
});

process.on('SIGINT',  () => { if (_imuInterval) clearInterval(_imuInterval); process.exit(0); });
process.on('SIGTERM', () => { if (_imuInterval) clearInterval(_imuInterval); process.exit(0); });
