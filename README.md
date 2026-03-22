# YAVAR
### Gyroscopic Stability System — v1.0

> Real-time vessel orientation and stability monitoring. Pi-deployable. Single-file. Production-grade.

---

## Overview

YAVAR is a maritime gyroscopic stability terminal designed for real-time vessel orientation monitoring. It reads live pitch, roll, and heading data from an MPU-9250 IMU sensor over I2C, processes it through a complementary filter, and renders it in a precision nautical dashboard — complete with a gyroscopic compass, stability scoring engine, calibration system, and full sensor log.

Runs as a single HTML file served from a Raspberry Pi. No framework. No build step. Opens in any browser on the local network.

---

## Features

**Live Sensor Data**
- Real-time pitch (bow/stern) and roll (port/starboard) from MPU-9250 via I2C (bus 1, addr `0x68`)
- Heading tracker — full 0–360° compass bearing
- Complementary filter at α=0.96 for smooth, accurate readings
- 2-second logging interval, 50-entry rolling sensor log

**Stability Engine**
- Real-time stability score (0–100)
- Automatic grade classification: `NOMINAL` / `WARN` / `CRITICAL`
- Visual stability bar with live colour transitions
- Orientation state tracking: FLAT / TILTED / CRITICAL

**Sensor Input Modes**
- Primary: MPU-9250 over WebSocket IMU bridge (`ws://vessel:3000`)
- Fallback 1: Device gyroscope (mobile browser)
- Fallback 2: Helm simulation via mouse (desktop, no sensor)

**Calibration**
- Zero-point calibration — set offsets at any orientation
- Calibration synced to Pi via `/api/calibration/set`
- Factory reset via `/api/calibration/reset`
- Calibration history tracking (count + last timestamp)

**Security**
- SHA-256 credential hashing
- Pi API auth with session token (`/api/auth`)
- Standalone credential fallback for offline use
- 3-attempt lockout

**Design System**
- Maritime aesthetic — cream / khaki / ocean palette
- Nautical chart SVG background
- Gyroscopic compass canvas renderer
- JetBrains Mono throughout
- Fully responsive — mobile and desktop

---

## Hardware

| Component | Spec |
|---|---|
| Board | Raspberry Pi (any model with I2C) |
| IMU Sensor | MPU-9250 |
| Interface | I2C — Bus 1, Address `0x68` |
| WebSocket Bridge | `ws://vessel:3000` |

---

## Tech Stack

- **Runtime**: Vanilla JS — zero dependencies
- **Sensor Bridge**: WebSocket (`ws://vessel:3000`)
- **Device Fallback**: DeviceOrientationEvent API
- **Auth**: SHA-256 client-side + Pi API token
- **Canvas**: HTML5 Canvas — gyroscopic compass renderer
- **Typography**: JetBrains Mono (Google Fonts)
- **Deployment**: Single `.html` file served from Raspberry Pi

---

## Deployment

```bash
# On the Pi — serve the file
npx serve .
# or
python3 -m http.server 8080

# Access from any device on local network
http://vessel.local:8080/YAVAR.html
```

The WebSocket IMU bridge (`ws://vessel:3000`) should be running on the Pi alongside a Node.js server reading the MPU-9250 via I2C.

---

## Architecture

```
YAVAR.html
├── Login & SHA-256 Auth (Pi API + standalone fallback)
├── Intro Splash
├── Boot Sequence (system check log)
├── App Shell
│   ├── Top Bar — Live status, UTC clock, sensor state
│   ├── Panel Nav — Live Data / Sensor Log / Calibration / System
│   ├── Gyroscope Panel
│   │   ├── Roll axis display (port/starboard)
│   │   ├── Pitch axis display (bow/stern)
│   │   ├── Stability score + grade
│   │   └── Gyroscopic compass (canvas)
│   ├── Sensor Log — timestamped rolling table
│   ├── Calibration Panel — zero-point set, offset display, history
│   └── System / About Panel
├── Complementary Filter Engine (α=0.96)
├── WebSocket IMU Bridge
├── Device Orientation Fallback
├── Helm Simulation (mouse fallback)
└── Status Bar — sensor state, stability, axis readings
```

---

## Sensor Input Priority

```
1. WebSocket IMU bridge (MPU-9250 via Pi)
   ↓ if unavailable
2. Device gyroscope (mobile DeviceOrientationEvent)
   ↓ if unavailable
3. Helm simulation (mouse-driven, desktop)
```

---

*YAVAR Systems © 2026 — Gyroscopic Stability & Maritime Orientation*
