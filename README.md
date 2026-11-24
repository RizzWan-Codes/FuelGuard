# FuelGuard

> Autonomous Dual-Sensing Fuel Quality Monitoring, Phase Separation Detection, and Closed-Loop Remediation System for Ethanol-Blended Gasoline.

---

## Overview

Modern commercial automotive fuels commonly utilize ethanol-gasoline blends (such as E10 and E20). Due to ethanol's hygroscopic properties, fuel stored in atmospheric or vented tanks naturally absorbs moisture. When water contamination exceeds the critical thermodynamic water tolerance boundary, the blend undergoes macroscopic liquid-liquid phase separation. 

This separation produces two distinct fluid layers:
1. An upper, octane-depleted hydrocarbon layer.
2. A dense, corrosive aqueous ethanol-water layer that settles at the tank bottom.

If ingested by the high-pressure fuel delivery pump, this aqueous layer causes immediate lean misfires, cavitation, mechanical pump seizure, and injector corrosion.

**FuelGuard** provides continuous, real-time in-tank monitoring to detect phase separation before contaminated fuel reaches critical powertrain components. Utilizing an orthogonal dual-transducer sensing design coupled with an embedded fail-safe controller, the system autonomously triggers active scavenging and stabilizer remediation.

---

## Key Features

- **Orthogonal Dual-Sensing**: Combines AC-pulsed electrical conductivity measurement with an optical transmission and refraction interface to distinguish water ingress from varying ethanol concentrations without ambiguity.
- **Electrolysis-Free Sensing Circuit**: Driven by pulsed high-speed excitation to eliminate DC galvanic erosion and probe plating over prolonged immersion cycles.
- **Deterministic 8-State Finite State Machine**: Bare-metal, non-blocking cooperative multitasking architecture ensuring predictable real-time execution.
- **Embedded Web Console & PWA**: Served entirely from on-chip LittleFS flash storage with zero external cloud dependencies. Features offline caching, responsive controls, and custom SVG interface elements.
- **Dual-Stage Actuation**: Optocoupled outputs for driving an active sump scavenge pump and chemical stabilizer micro-dosing mechanism.
- **In-Situ Calibration Engine**: Multi-point piecewise interpolation stored directly to non-volatile JSON configuration files on flash.

---

## System Architecture

```
                       +-------------------------------+
                       |    ESP8266EX Microcontroller  |
                       |    32-bit Tensilica L106 Core |
                       +---------------+---------------+
                                       |
          +----------------------------+----------------------------+
          |                            |                            |
          v                            v                            v
+--------------------+       +--------------------+       +--------------------+
|  Pulsed AC Sensing |       | Optical Refraction |       |  I2C / SPI Display |
|  Transducer (A0)   |       | Interface (GPIO13) |       |  SH1106 128x64 OLED|
+--------------------+       +--------------------+       +--------------------+
          |                            |
          +--------------+-------------+
                         |
                         v
          +----------------------------+
          |  8-State Decision Engine   |
          |  Deterministic FSM         |
          +--------------+-------------+
                         |
          +--------------+-------------+
          |                            |
          v                            v
+--------------------+       +--------------------+
| Sump Purge Relay   |       | Dosing Pump Relay  |
| GPIO16 (Scavenge)  |       | GPIO2 (Stabilizer) |
+--------------------+       +--------------------+
```

---

## Hardware Pinout & Peripherals

The table below describes the pin mappings and hardware assignments configured in firmware for the ESP8266 NodeMCU V3 platform:

| Pin / GPIO | Hardware Identifier | Peripheral Function | Electrical Specification |
|:---|:---|:---|:---|
| **A0 (TOUT)** | Analog Channel 0 | Conductivity Sensing Return | 0.0V - 1.0V (0 - 1023 ADC SAR input) |
| **GPIO12 (D6)** | EXCITE | AC Pulse Excitation Drive | 3.3V Logic, High-Speed Pulsed Signal |
| **GPIO13 (D7)** | LDR | Optical Detector Interface | Digital input from phototransistor / CdS stage |
| **GPIO16 (D0)** | R1 | Scavenge Purge Pump Relay | Active-low optocoupler input (12V diaphragm pump) |
| **GPIO2 (D4)** | R2 | Chemical Dosing Pump Relay | Active-low optocoupler input (Peristaltic pump) |
| **GPIO4 (D2)** | RED | Fault / Warning Status LED | 3.3V logic drive via current-limiting resistor |
| **GPIO5 (D1)** | GREEN | Operational Status LED | 3.3V logic drive via current-limiting resistor |
| **GPIO14 (D5)**| BUZZER | Acoustic Alert Output | Active piezo alarm transducer |
| **GPIO15 (D8)**| OLED_CS / CLK | SH1106 Graphic Display | 4-Wire Software SPI Clock Line |
| **GPIO0 (D3)** | OLED_MOSI | SH1106 Data Line | Software SPI Master-Out Slave-In |
| **TX (GPIO1)** | OLED_DC | SH1106 Command/Data Select | Dedicated display control line (Serial disabled) |

---

## Finite State Machine (FSM)

The core control firmware operates a non-blocking 8-state cooperative state machine:

```
[WELCOME] ---> [EMPTY] ---> [MONITOR] <--------------------+
                  |             |                           |
                  v             v (Phase Separation)        |
               [FAULT]     [COUNTDOWN]                      |
                                |                           |
                                v (Timer Elapsed)           |
                            [FLUSHING]                      |
                                |                           |
                                v (Threshold Clear)         |
                           [FLUSH_DONE] --------------------+
                                |
                                v (Manual Stop / E-Stop)
                            [STOPPED]
```

### State Definitions

1. **WELCOME**: Power-on initialization state; executes hardware selftests, mounts LittleFS, initializes display drivers, and configures Wi-Fi SoftAP.
2. **EMPTY**: Active when probes detect no fluid presence (open circuit). Relays remain locked out.
3. **MONITOR**: Normal operating state. Executes alternating periodic sensing cycles, calculates smoothed metrics, and compares values against calibrated limits.
4. **COUNTDOWN**: Triggered upon threshold violation. Provides a safety confirmation delay to prevent transient false-positive trips.
5. **FLUSHING**: Closes the primary scavenge relay (R1) to evacuate contaminated bottom-settled fluid from the sump collector.
6. **FLUSH_DONE**: Post-purge verification cycle. Confirms return to nominal fluid purity before disengaging active remediation.
7. **STOPPED**: Manual override state entered via physical stop button or authenticated API command.
8. **FAULT**: System protective lockout triggered if sensor signals exceed electrical safety limits or pump lease times expire.

---

## RESTful Web API

The onboard HTTP daemon provides a JSON-based control and telemetry API accessible via the local access point network:

| Endpoint | Method | Authentication | Description |
|:---|:---|:---|:---|
| `/api/status` | `GET` | Public | Returns real-time telemetry, state machine status, and raw sensor readings. |
| `/api/logs` | `GET` | Public | Retrieves recent circular buffer log entries and transition timestamps. |
| `/api/calibration` | `GET` | Public | Retrieves stored calibration data points and polynomial coefficients. |
| `/api/login` | `POST` | Public | Authenticates admin session tokens for control and calibration overrides. |
| `/api/mode` | `POST` | Authenticated | Toggles system between Autonomous and Manual intervention modes. |
| `/api/pump` | `POST` | Authenticated | Manually triggers the scavenge purge pump with a bounded lease timeout. |
| `/api/booster` | `POST` | Authenticated | Dispatches a micro-dose cycle via the chemical dosing peristaltic pump. |
| `/api/stop` | `POST` | Public | Immediate emergency stop; de-energizes all relays and latches `STOPPED`. |
| `/api/heartbeat` | `POST` | Authenticated | Extends safety operational lease during active client web connection. |
| `/api/calibration` | `POST` | Authenticated | Captures current sensor voltage as a named reference blend calibration point. |

---

## Local Web Application

The system hosts an onboard Progressive Web Application served directly from embedded LittleFS flash:

- **Offline-First PWA**: Fully functional without internet connectivity via modern browser caching (`sw.js`).
- **Telemetry Visualizer**: Dynamic live-updating chart rendering electrical conductivity curves and trigger points.
- **Diagnostic Controls**: Manual override toggles, dosing triggers, and audit logging.
- **Calibration Wizard**: Interactive zero-point and span calibration directly from mobile or desktop browsers.
- **Access Details**:
  - Default SSID: `FuelGuard`
  - Default Password: `fuelguard123`
  - Local Hostname: `http://fuelguard.local` or `http://192.168.4.1`

---

## Repository Structure

```
FuelGuard_final/
├── FuelGuard_final.ino    # Main firmware source (C++, state machine, HTTP handlers)
├── wifi_qr.h             # Monochrome QR bitmap matrix for Wi-Fi onboarding
├── push_in_intervals.ps1 # Automation script for periodic updates
├── data/                 # LittleFS root asset directory
│   ├── index.html        # Single-page web dashboard application
│   ├── app.js            # PWA logic, live chart engine, and REST client
│   ├── sw.js             # Service Worker for local resource caching
│   └── manifest.webmanifest # PWA install metadata and vector icon manifests
└── README.md             # Project documentation
```

---

## Setup & Compilation

### Requirements
- **Arduino IDE** (version 2.0+ recommended) or **Arduino CLI**.
- **ESP8266 Board Package**: version `3.1.2` or later.
- Required Libraries:
  - `ArduinoJson` (v6.21.5)
  - `U8g2` (latest release)
  - `ESP8266WiFi`, `ESP8266WebServer`, `LittleFS`, `Ticker` (included in core)

### Board Configuration Settings
- **Board**: `NodeMCU 1.0 (ESP-12E Module)`
- **CPU Frequency**: `80 MHz` (or `160 MHz` for faster rendering)
- **Flash Size**: `4MB (FS: 2MB)` or `4MB (FS: 3MB)`
- **Upload Speed**: `921600` or `115200`
- **Erase Flash**: `Only Sketch` (or `All Flash Contents` during initial setup)

### Flashing Steps
1. Open `FuelGuard_final.ino` in Arduino IDE.
2. Verify board package settings match the specifications above.
3. Upload the LittleFS filesystem image using the **ESP8266 LittleFS Data Upload** tool to transfer files from the `data/` folder.
4. Compile and flash the sketch to the target microcontroller over USB.

---

## Technical Specifications

| Parameter | Specification |
|:---|:---|
| Microcontroller | Espressif ESP8266EX (32-bit RISC @ 80/160 MHz) |
| Supply Input | 12V DC (automotive battery bus) with on-board buck conversion to 5V / 3.3V |
| Idle Power Draw | Under 120 mA @ 12V DC |
| Scavenge Pump Output | Up to 4.0 L/min open flow (Viton diaphragm assembly) |
| Sensing Frequency | 10 Hz AC pulse interrogation |
| Sampling Latency | Less than 850 milliseconds to state transition |
| Optical Spectrum | 940 nm narrow-beam infrared emitter with matching photo-detector |
| Local Interface | 1.3-inch 128x64 monochrome OLED (SH1106 controller) |
| Network Mode | IEEE 802.11 b/g/n Wi-Fi SoftAP with WPA2-PSK |

---

## Safety & Operational Disclaimer

This project is a functional engineering prototype and bench demonstration system. While designed around low-voltage sensing and isolated relay control, installation in real vehicular fuel tanks requires certified explosion-proof enclosures, intrinsically safe galvanic barriers (e.g., ATEX / IECEx Zone 0 compliance), and fuel-rated materials certified against aggressive ethanol corrosion.

---

## License

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at:

[http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0)

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the [LICENSE](LICENSE) file for the specific language governing permissions and limitations under the License.
