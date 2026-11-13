/* FuelGuard 2.0 — ESP8266 NodeMCU + SH1106. Water-only bench demonstration.
   A0 is a raw conductivity proxy. No fuel-safety or ethanol-removal certification.
   Libraries: U8g2; ArduinoJson 6.21.5. ESP8266 core 3.1.2.
   TX is OLED DC: do not enable Serial. D6 stays HIGH after initial reset.
*/

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <LittleFS.h>
#include <U8g2lib.h>
#include <Ticker.h>
#include <ArduinoJson.h>
#include <ESP8266mDNS.h>

extern "C" {
#include <user_interface.h>
}

#include "wifi_qr.h"

// ============================================================
// HARDWARE
// ============================================================

const uint8_t R1     = 16;
const uint8_t R2     = 2;
const uint8_t RED    = 4;
const uint8_t GREEN  = 5;
const uint8_t BUZZER = 14;
const uint8_t EXCITE = 12;
const uint8_t LDR    = 13;

// ============================================================
// WI-FI
// ============================================================

const char* AP_NAME     = "FuelGuard";
const char* AP_PASSWORD = "fuelguard123";

// ============================================================
// SENSOR LIMITS
// Change HIGH_LIMIT here only if threshold needs adjustment.
// ============================================================

const int SAMPLE_MIN = 50;
const int HIGH_LIMIT = 240;

// ============================================================
// TIMING
// ============================================================

const uint32_t MANUAL_LEASE = 3000;
const uint32_t AUTH_TTL     = 1800000;

// ============================================================
// OLED
// ============================================================

U8G2_SH1106_128X64_NONAME_F_4W_SW_SPI display(
  U8G2_R0,
  15,
  0,
  U8X8_PIN_NONE,
  1,
  U8X8_PIN_NONE
);

// ============================================================
// SERVER
// ============================================================

ESP8266WebServer server(80);
Ticker cutoff;

// ============================================================
// SYSTEM STATE
// ============================================================

enum Phase {
  WELCOME,
  EMPTY,
  MONITOR,
  COUNTDOWN,
  FLUSHING,
  FLUSH_DONE,
  STOPPED,
  FAULT
};

Phase phase = WELCOME;

uint32_t phaseAt = 0;
uint32_t readAt = 0;
uint32_t drawAt = 0;
uint32_t pumpAt = 0;
uint32_t pumpMs = 0;
uint32_t emptyAt = 0;
uint32_t leaseAt = 0;
uint32_t authAt = 0;
uint32_t webAt = 0;
uint32_t qrAt = 0;

uint32_t sampleId = 1;
uint32_t sequence = 0;
uint32_t flushMaxMs = 30000;
uint32_t failedLoginAt = 0;

bool fsReady = false;
bool apReady = false;
bool automatic = true;
bool qrStarted = false;
bool oledOn = true;
bool emptyTiming = false;

bool flushUsed = false;
bool doseUsed = false;
bool present = false;
bool greenOn = false;
bool redOn = false;
bool buzzOn = false;

bool webSeen = false;
bool failedLogin = false;
bool wasFlush = false;

volatile bool r1 = false;
volatile bool r2 = false;
volatile bool expired = false;

int raw = 0;
int ldrValue = 0;
int ldrCandidate = 0;
int ldrCount = 0;

String bootId;
String token;
String doseResult = "No dose started";

float doseMl = 0;

// ============================================================
// EVENTS
// ============================================================

struct Event {
  uint32_t id;
  uint32_t ms;
  uint32_t sample;
  char level[8];
  char text[112];
};

Event events[64];
uint32_t eventId = 0;

// ============================================================
// CALIBRATION
// ============================================================

struct Point {
  char name[25];
  float ethanol;
  float mean;
  float sd;
  uint16_t n;
};

Point points[12];
uint8_t pointCount = 0;

bool capturing = false;
Point capture;

uint32_t captureAt = 0;
double captureSum = 0;
double captureSquares = 0;
uint16_t captureN = 0;

String captureResult = "Idle";

// ============================================================
// LOGGING
// ============================================================

void logEvent(const char* level, const String& text) {
  Event &e = events[eventId % 64];

  e.id = ++eventId;
  e.ms = millis();
  e.sample = sampleId;

  strlcpy(e.level, level, sizeof(e.level));
  strlcpy(e.text, text.c_str(), sizeof(e.text));
}

// ============================================================
// PUMP CONTROL
// ============================================================

bool boosterLowPower = false;
uint8_t previousCpuMHz = 80;

void restoreBoosterPower() {
  if (!boosterLowPower) return;

  system_update_cpu_freq(previousCpuMHz);
  WiFi.setOutputPower(20.5f);

  boosterLowPower = false;
}

void pumpCutoff() {
  digitalWrite(R1, HIGH);
  digitalWrite(R2, HIGH);

  r1 = false;
  r2 = false;
  expired = true;
}

void stopPumps() {
  cutoff.detach();
  restoreBoosterPower();

  digitalWrite(R1, HIGH);
  digitalWrite(R2, HIGH);

  r1 = false;
  r2 = false;
  expired = false;
}

void oled(bool on) {
  if (oledOn != on) {
    display.setPowerSave(on ? 0 : 1);
    oledOn = on;
  }
}

void enter(Phase p) {
  phase = p;
  phaseAt = millis();
}

void startPump(uint8_t channel, uint32_t duration, bool isFlush) {
  stopPumps();

  wasFlush = isFlush;
  pumpAt = millis();
  pumpMs = duration;

 if (channel == 1) {
  oled(false);

  r1 = true;
  digitalWrite(R1, LOW);
} else {
  oled(false);

  previousCpuMHz = ESP.getCpuFreqMHz();
  boosterLowPower = true;

  system_update_cpu_freq(80);
  WiFi.setOutputPower(10.0f);

  r2 = true;
  digitalWrite(R2, LOW);
}

  cutoff.once_ms(duration, pumpCutoff);

  logEvent(
    "info",
    String("Pump ") + channel +
    " ON; cutoff " +
    String(duration / 1000.0f, 1) +
    " s"
  );
}

void stopLogged(const String& reason) {
  if (r1 || r2 || expired) {
    logEvent("info", reason);
  }

  stopPumps();
  oled(true);
}

// ============================================================
// API HELPERS
// ============================================================

void replyError(int code, const String& msg) {
  StaticJsonDocument<256> d;

  d["ok"] = false;
  d["error"] = msg;

  String s;
  serializeJson(d, s);

  server.send(code, "application/json", s);
}

bool command() {
  if (server.header("X-FuelGuard") != "1") {
    replyError(403, "Open the FuelGuard dashboard");
    return false;
  }

  return true;
}

bool authenticated() {
  if (!command()) return false;

  if (
    token.length() != 32 ||
    server.header("Authorization") != String("Bearer ") + token ||
    uint32_t(millis() - authAt) > AUTH_TTL
  ) {
    replyError(401, "Unlock with the Wi-Fi password");
    return false;
  }

  return true;
}

bool numArg(const char* key, float lo, float hi, float &out) {
  if (!server.hasArg(key)) return false;

  String s = server.arg(key);
  char* end;

  out = strtof(s.c_str(), &end);

  return (
    end != s.c_str() &&
    *end == '\0' &&
    isfinite(out) &&
    out >= lo &&
    out <= hi
  );
}

bool currentSample() {
  if (
    server.arg("bootId") != bootId ||
    server.arg("sampleId") != String(sampleId)
  ) {
    replyError(409, "Sample changed; refresh and retry");
    return false;
  }

  return true;
}

void jsonSend(JsonDocument& d) {
  String s;
  serializeJson(d, s);

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", s);
}

// ============================================================
// CALIBRATION STORAGE
// ============================================================

void loadCalibration() {
  if (!fsReady) return;

  File f = LittleFS.open("/calibration.json", "r");
  if (!f) return;

  DynamicJsonDocument d(4096);

  auto err = deserializeJson(d, f);
  f.close();

  if (err || d["version"] != 1) {
    logEvent("warn", "Calibration file invalid; ignored");
    return;
  }

  for (JsonObject a : d["points"].as<JsonArray>()) {
    float m = a["mean"] | NAN;
    float e = a["ethanol"] | NAN;
    float sd = a["sd"] | NAN;

    if (
      pointCount >= 12 ||
      !isfinite(m) ||
      !isfinite(e) ||
      !isfinite(sd) ||
      m < SAMPLE_MIN ||
      m > 1023 ||
      e < 0 ||
      e > 100 ||
      sd < 0
    ) {
      continue;
    }

    Point &p = points[pointCount++];

    strlcpy(p.name, a["name"] | "Sample", 25);

    p.mean = m;
    p.ethanol = e;
    p.sd = sd;
    p.n = a["n"] | 0;
  }
}

bool saveCalibration() {
  if (!fsReady) return false;

  DynamicJsonDocument d(4096);

  d["version"] = 1;

  JsonArray a = d.createNestedArray("points");

  for (uint8_t i = 0; i < pointCount; i++) {
    JsonObject o = a.createNestedObject();

    o["name"] = points[i].name;
    o["mean"] = points[i].mean;
    o["ethanol"] = points[i].ethanol;
    o["sd"] = points[i].sd;
    o["n"] = points[i].n;
  }

  File f = LittleFS.open("/calibration.tmp", "w");

  if (!f) return false;

  bool ok = serializeJson(d, f) > 0;

  f.flush();
  f.close();

  if (!ok) return false;

  return LittleFS.rename(
    "/calibration.tmp",
    "/calibration.json"
  );
}

// ============================================================
// ETHANOL ESTIMATION
// ============================================================

float estimate(float value) {
  if (pointCount < 2 || value < SAMPLE_MIN) {
    return NAN;
  }

  uint8_t order[12];

  for (uint8_t i = 0; i < pointCount; i++) {
    order[i] = i;
  }

  for (uint8_t i = 0; i < pointCount; i++) {
    for (uint8_t j = i + 1; j < pointCount; j++) {
      if (points[order[j]].mean < points[order[i]].mean) {
        uint8_t t = order[i];
        order[i] = order[j];
        order[j] = t;
      }
    }
  }

  int direction = 0;

  for (uint8_t i = 1; i < pointCount; i++) {
    Point &a = points[order[i - 1]];
    Point &b = points[order[i]];

    if (
      b.mean - a.mean <
      max(12.0f, 3.0f * (a.sd + b.sd))
    ) {
      return NAN;
    }

    float delta = b.ethanol - a.ethanol;

    if (fabsf(delta) < 0.01f) {
      return NAN;
    }

    int sign = delta > 0 ? 1 : -1;

    if (direction && sign != direction) {
      return NAN;
    }

    direction = sign;
  }

  if (
    value < points[order[0]].mean ||
    value > points[order[pointCount - 1]].mean
  ) {
    return NAN;
  }

  for (uint8_t i = 1; i < pointCount; i++) {
    Point &a = points[order[i - 1]];
    Point &b = points[order[i]];

    if (value <= b.mean) {
      return a.ethanol +
             (value - a.mean) *
             (b.ethanol - a.ethanol) /
             (b.mean - a.mean);
    }
  }

  return NAN;
}

// ============================================================
// CALIBRATION CAPTURE
// ============================================================

void tickCalibration() {
  if (!capturing) return;

  captureSum += raw;
  captureSquares += double(raw) * raw;
  captureN++;

  if (uint32_t(millis() - captureAt) < 10000) {
    return;
  }

  capturing = false;

  capture.mean = captureSum / captureN;

  capture.sd = sqrt(
    max(
      0.0,
      double(captureSquares / captureN) -
      double(capture.mean) * capture.mean
    )
  );

  capture.n = captureN;

  if (
    capture.mean < SAMPLE_MIN ||
    capture.sd > 12 ||
    captureN < 80
  ) {
    captureResult =
      "Rejected: absent or unstable sample; try again";

    logEvent("warn", captureResult);
    return;
  }

  points[pointCount++] = capture;

  if (!saveCalibration()) {
    pointCount--;

    captureResult =
      "Save failed; calibration not retained";

    logEvent("error", captureResult);
    return;
  }

  captureResult =
    String("Saved ") +
    capture.name +
    " at A0 " +
    String(capture.mean, 1);

  logEvent("info", captureResult);
}

// ============================================================
// MAIN CONTROL LOGIC
// ============================================================

void tickControl() {
  uint32_t now = millis();

if (expired) {
  expired = false;

  restoreBoosterPower();
  oled(true);

    logEvent(
      wasFlush ? "warn" : "info",
      wasFlush
        ? "Flush timeout; pump stopped"
        : "Timed pump run complete"
    );

    if (wasFlush) {
      enter(FAULT);
    } else {
      doseResult = "Timed run complete";
    }
  }

  if (
    !automatic &&
    (r1 || r2) &&
    uint32_t(now - leaseAt) > MANUAL_LEASE
  ) {
    stopLogged("Manual heartbeat lost; pumps stopped");
    enter(STOPPED);
  }

  if (
    !automatic &&
    token.length() &&
    uint32_t(now - authAt) > AUTH_TTL
  ) {
    stopLogged("Authorization expired; pumps stopped");

    token = "";

    logEvent(
      "warn",
      "Manual authorization expired"
    );
  }

  // Sensor sampling every 100 ms
  if (uint32_t(now - readAt) < 100) {
    return;
  }

  readAt = now;

  raw = analogRead(A0);
  sequence++;

  // LDR debounce
  int l = digitalRead(LDR);

  if (l != ldrCandidate) {
    ldrCandidate = l;
    ldrCount = 1;
  } else if (ldrCount < 5) {
    ldrCount++;
  }

  if (ldrCount == 5 && ldrValue != l) {
    ldrValue = l;

    logEvent(
      "info",
      String("Optical state: ") +
      (l ? "HIGH / water-like" : "LOW / petrol-like")
    );
  }

  tickCalibration();

  // Welcome screen
  if (phase == WELCOME) {
    if (uint32_t(now - phaseAt) < 1500) {
      return;
    }

    enter(raw < SAMPLE_MIN ? EMPTY : MONITOR);
  }

  if (!automatic || capturing) {
    return;
  }

  // ----------------------------------------------------------
  // AUTOMATIC FLUSH
  // ----------------------------------------------------------

  if (phase == FLUSHING) {
    if (raw < HIGH_LIMIT) {
      stopLogged(
        String("Flush stopped: A0 ") +
        raw +
        " below " +
        String(HIGH_LIMIT) +
        "; removal unverified"
      );

      enter(FLUSH_DONE);
    }

    return;
  }

if (phase == FLUSH_DONE) {
  if (
    raw < HIGH_LIMIT &&
    uint32_t(now - phaseAt) < 3000
  ) {
    return;
  }

  enter(MONITOR);
}

  // ----------------------------------------------------------
  // SAMPLE REMOVED / EMPTY
  // ----------------------------------------------------------

  if (raw < SAMPLE_MIN) {
    if (r2) {
      stopLogged("Dose interrupted: sample absent");
      doseResult = "Interrupted: sample absent";
    }

    if (!emptyTiming) {
      emptyTiming = true;
      emptyAt = now;
    }

    if (uint32_t(now - emptyAt) >= 2000) {
      if (
        present ||
        flushUsed ||
        doseUsed ||
        phase == FAULT ||
        phase == STOPPED
      ) {
        logEvent("info", "Sample removed; cycle reset");
        sampleId++;
      }

      present = false;
      flushUsed = false;
      doseUsed = false;

      enter(EMPTY);
    } else if (
      phase != FAULT &&
      phase != STOPPED
    ) {
      enter(EMPTY);
    }

    return;
  }

  // ----------------------------------------------------------
  // SAMPLE PRESENT
  // ----------------------------------------------------------

  emptyTiming = false;

  if (!present) {
    present = true;

    logEvent(
      "info",
      String("Sample detected: A0 ") + raw
    );
  }

  if (
    phase == STOPPED ||
    phase == FAULT
  ) {
    return;
  }

  if (phase == EMPTY) {
    enter(MONITOR);
  }

  // ----------------------------------------------------------
  // COUNTDOWN
  // ----------------------------------------------------------

  if (phase == COUNTDOWN) {
    if (raw < HIGH_LIMIT) {
      enter(MONITOR);

      logEvent(
        "info",
        "Flush countdown cancelled; reading recovered"
      );

      return;
    }

    if (uint32_t(now - phaseAt) >= 3000) {
      flushUsed = true;

      enter(FLUSHING);

      startPump(
        1,
        flushMaxMs,
        true
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // HIGH LIMIT
  // ----------------------------------------------------------

  if (raw >= HIGH_LIMIT) {
    if (r2) {
      stopLogged("Dose interrupted: above limit");

      doseResult =
        "Interrupted: above limit";
    }

    if (phase == MONITOR) {
      enter(COUNTDOWN);

      logEvent(
        "warn",
        String("Limit reached! : ") +
        raw +
        " (threshold " +
        String(HIGH_LIMIT) +
        ")"
      );
    }
  }
}

// ============================================================
// STATE NAME
// ============================================================

String stateName() {
  if (capturing) {
    return "calibrating";
  }

  if (!automatic) {
    return r1 || r2
      ? "manual-running"
      : "manual-hold";
  }

  switch (phase) {
    case WELCOME:
      return "welcome";

    case COUNTDOWN:
      return "countdown";

    case FLUSHING:
      return "flushing";

    case FLUSH_DONE:
      return "flushed";

    case STOPPED:
      return "stopped";

    case FAULT:
      return "fault";

    default:
      break;
  }

  if (raw < SAMPLE_MIN) {
    return "empty";
  }

  if (raw >= HIGH_LIMIT) {
    return "high";
  }

  if (r2) {
    return "boosting";
  }

  return ldrValue
    ? "optical-review"
    : "within-limit";
}

// ============================================================
// LED / BUZZER
// ============================================================

void tickIndicators() {
  uint32_t elapsed = millis() - phaseAt;

  bool welcome = phase == WELCOME;

  bool alarm =
    !welcome &&
    (
      raw >= HIGH_LIMIT ||
      phase == FAULT ||
      phase == FLUSHING
    );

  redOn = alarm;

  greenOn =
    welcome ||
    (
      !alarm &&
      raw >= SAMPLE_MIN &&
      millis() % 2000 < 250
    );

  buzzOn =
    welcome
      ? (
          elapsed < 200 ||
          (elapsed >= 400 && elapsed < 600)
        )
      : (
          alarm &&
          millis() % 1000 < 180
        );

  digitalWrite(RED, redOn);
  digitalWrite(GREEN, greenOn);
  digitalWrite(BUZZER, buzzOn);
}

// ============================================================
// OLED HELPERS
// ============================================================

void line(int y, const String& s) {
  int x = max(
    0,
    (128 - int(display.getStrWidth(s.c_str()))) / 2
  );

  display.drawStr(
    x,
    y,
    s.c_str()
  );
}

// ============================================================
// OLED DASHBOARD
// ============================================================

void drawOled() {
  if (
    !oledOn ||
    uint32_t(millis() - drawAt) < 125
  ) {
    return;
  }

  drawAt = millis();

  display.clearBuffer();
  display.setDrawColor(1);
  display.setFont(u8g2_font_4x6_tr);

  const char* labels[] = {
    "R1",
    "R2",
    "G",
    "R",
    "BZ",
    "WF",
    "WEB"
  };

  bool icons[] = {
    r1,
    r2,
    greenOn,
    redOn,
    buzzOn,
    WiFi.softAPgetStationNum() > 0,
    webSeen &&
      uint32_t(millis() - webAt) < 4000
  };

  for (int i = 0; i < 7; i++) {
    int x = i * 18;

    if (icons[i]) {
      display.drawRBox(
        x,
        0,
        17,
        13,
        2
      );
    } else {
      display.drawRFrame(
        x,
        0,
        17,
        13,
        2
      );
    }

    display.setDrawColor(
      icons[i] ? 0 : 1
    );

    display.drawStr(
      x + 2,
      9,
      labels[i]
    );
  }

  display.setDrawColor(1);
  display.setFont(u8g2_font_6x10_tr);

  if (phase == WELCOME) {
    line(33, "Welcome to");
    line(52, "FuelGuard");
  }

  else if (capturing) {
    line(30, "Calibrating sample");
    line(45, String("A0: ") + raw);
    line(61, "Keep electrodes still");
  }

  else if (!automatic) {
    line(30, "MANUAL CONTROL");
    line(45, String("A0: ") + raw);

    line(
      61,
      r1 || r2
        ? "Pump running"
        : "Pumps stopped"
    );
  }

  else if (phase == COUNTDOWN) {
    line(
      29,
      String("Limit reached! : ") + raw
    );

    line(
      45,
      String("Flush in ") +
      String(
        (
          3000 -
          (millis() - phaseAt) +
          999
        ) / 1000
      ) +
      " s"
    );
  }

  else if (phase == FAULT) {
    line(31, "FLUSH TIMEOUT");
    line(48, "Remove sample");
  }

  else if (phase == STOPPED) {
    line(31, "PUMPS STOPPED");
    line(48, "Remove to reset");
  }

  else if (phase == FLUSH_DONE) {
    line(31, "Flush stopped");
    line(
      48,
      String("Reading: ") + raw
    );
  }

  else if (raw < SAMPLE_MIN) {
    if (
      apReady &&
      !qrStarted
    ) {
      qrStarted = true;
      qrAt = millis();
    }

    uint32_t elapsed =
      millis() - qrAt;

    if (
      apReady &&
      qrStarted &&
      elapsed < 15000
    ) {
      display.setBitmapMode(0);

      display.drawXBMP(
        2,
        23,
        37,
        37,
        WIFI_QR_BITS
      );

      display.drawStr(
        44,
        30,
        "Scan to join"
      );

      display.drawStr(
        44,
        43,
        "FuelGuard"
      );

      display.drawStr(
        44,
        57,
        (
          String(
            (
              15000 -
              elapsed +
              999
            ) / 1000
          ) +
          " s left"
        ).c_str()
      );
    }

    else {
      line(32, "Add sample");

      line(
        49,
        apReady
          ? "FuelGuard Wi-Fi"
          : "Wi-Fi start failed"
      );

      line(
        62,
        "192.168.4.1"
      );
    }
  }

  else {
    line(
      30,
      String("A0: ") + raw
    );

    line(
      46,
      raw >= HIGH_LIMIT
        ? String("Limit reached! : ") + raw
        : (
            ldrValue
              ? "Optical: petrol-like"
              : "Optical: water-like"
          )
    );

    line(
      62,
      r2
        ? "Adding booster"
        : "Conductivity first"
    );
  }

  display.sendBuffer();
}

// ============================================================
// STATUS API
// ============================================================

void sendStatus() {
  webAt = millis();
  webSeen = true;

  DynamicJsonDocument d(2048);

  d["ok"] = true;

  d["bootId"] = bootId;
  d["sampleId"] = sampleId;

  d["seq"] = sequence;
  d["uptimeMs"] = millis();

  d["raw"] = raw;

  d["sampleMin"] = SAMPLE_MIN;
  d["highLimit"] = HIGH_LIMIT;

  d["ldrDigital"] = ldrValue;

  d["state"] = stateName();

  d["mode"] =
    automatic
      ? "automatic"
      : "manual";

  d["r1"] = bool(r1);
  d["r2"] = bool(r2);

  d["green"] = greenOn;
  d["red"] = redOn;
  d["buzzer"] = buzzOn;

  d["oled"] = oledOn;

  d["clients"] =
    WiFi.softAPgetStationNum();

  d["webActive"] = true;

  d["fsReady"] = fsReady;
  d["apReady"] = apReady;

  d["flushUsed"] = flushUsed;
  d["doseUsed"] = doseUsed;

  d["doseMl"] = doseMl;
  d["doseResult"] = doseResult;

  d["canDose"] =
    automatic &&
    phase == MONITOR &&
    raw >= SAMPLE_MIN &&
    raw < HIGH_LIMIT &&
    !r1 &&
    !r2 &&
    !doseUsed;

  uint32_t elapsed =
    millis() - pumpAt;

  d["pumpRemainingMs"] =
    (r1 || r2) &&
    elapsed < pumpMs
      ? pumpMs - elapsed
      : 0;

  elapsed =
    millis() - phaseAt;

  d["countdown"] =
    phase == COUNTDOWN &&
    elapsed < 3000
      ? (
          3000 -
          elapsed +
          999
        ) / 1000
      : 0;

  d["flushMaxSeconds"] =
    flushMaxMs / 1000;

  d["capturing"] =
    capturing;

  d["captureProgress"] =
    capturing
      ? min(
          100UL,
          (millis() - captureAt) / 100
        )
      : 0;

  d["captureResult"] =
    captureResult;

  d["calibrationCount"] =
    pointCount;

  d["eventId"] =
    eventId;

  float e = estimate(raw);

  if (isfinite(e)) {
    d["ethanolEstimate"] = e;
  } else {
    d["ethanolEstimate"] = nullptr;
  }

  d["sensorConflict"] =
    raw >= SAMPLE_MIN &&
    (
      (
        raw < HIGH_LIMIT &&
        ldrValue == 1
      ) ||
      (
        raw >= HIGH_LIMIT &&
        ldrValue == 0
      )
    );

  jsonSend(d);
}

// ============================================================
// LOGIN
// ============================================================

void handleLogin() {
  if (!command()) return;

  if (
    failedLogin &&
    uint32_t(
      millis() - failedLoginAt
    ) < 2000
  ) {
    replyError(
      429,
      "Wait two seconds before retrying"
    );

    return;
  }

  if (
    server.arg("password") !=
    AP_PASSWORD
  ) {
    failedLogin = true;
    failedLoginAt = millis();

    logEvent(
      "warn",
      "Unlock failed"
    );

    replyError(
      401,
      "Incorrect Wi-Fi password"
    );

    return;
  }

  stopLogged(
    "New operator unlocked; previous pump run stopped"
  );

  automatic = false;
  enter(STOPPED);

  token = "";

  char b[9];

  for (int i = 0; i < 4; i++) {
    snprintf(
      b,
      9,
      "%08lx",
      (unsigned long)os_random()
    );

    token += b;
  }

  authAt = millis();
  leaseAt = millis();

  logEvent(
    "info",
    "Operator authenticated; manual hold enabled"
  );

  StaticJsonDocument<160> d;

  d["ok"] = true;
  d["token"] = token;

  jsonSend(d);
}

// ============================================================
// MODE
// ============================================================

void handleMode() {
  if (!authenticated()) return;

  String m =
    server.arg("mode");

  if (
    m != "automatic" &&
    m != "manual"
  ) {
    replyError(
      400,
      "Invalid mode"
    );

    return;
  }

  if (capturing) {
    replyError(
      409,
      "Finish or cancel calibration first"
    );

    return;
  }

  stopLogged(
    "Mode changed; pumps stopped"
  );

  automatic =
    m == "automatic";

  leaseAt = millis();

  enter(
    automatic
      ? (
          raw < SAMPLE_MIN
            ? EMPTY
            : MONITOR
        )
      : STOPPED
  );

  logEvent(
    "info",
    automatic
      ? "Automatic monitoring enabled"
      : "Manual override enabled"
  );

  sendStatus();
}

// ============================================================
// MANUAL PUMP
// ============================================================

void handlePump() {
  if (
    !authenticated() ||
    !currentSample()
  ) {
    return;
  }

  if (
    automatic ||
    capturing
  ) {
    replyError(
      409,
      "Select manual mode; finish calibration first"
    );

    return;
  }

  float channel;
  float seconds;

  if (
    !numArg(
      "channel",
      1,
      2,
      channel
    ) ||
    floorf(channel) != channel
  ) {
    replyError(
      400,
      "Invalid channel"
    );

    return;
  }

  if (
    server.arg("on") == "0"
  ) {
    stopLogged(
      "Manual OFF; both pumps stopped"
    );

    sendStatus();
    return;
  }

  if (
    server.arg("on") != "1" ||
    !numArg(
      "seconds",
      0.1,
      60,
      seconds
    )
  ) {
    replyError(
      400,
      "Run must be 0.1 to 60 seconds"
    );

    return;
  }

  leaseAt = millis();

  startPump(
    channel,
    lroundf(seconds * 1000),
    false
  );

  sendStatus();
}

// ============================================================
// EMERGENCY STOP
// ============================================================

void handleStop() {
  if (!command()) return;

  stopLogged(
    "Emergency stop requested"
  );

  if (capturing) {
    capturing = false;

    captureResult =
      "Capture cancelled by stop";
  }

  automatic = false;

  enter(STOPPED);

  flushUsed = true;
  doseUsed = true;

  logEvent(
    "warn",
    "Emergency stop; manual hold"
  );

  sendStatus();
}

// ============================================================
// BOOSTER
// ============================================================

void handleDose() {
  if (
    !authenticated() ||
    !currentSample()
  ) {
    return;
  }

  if (
    !automatic ||
    phase != MONITOR ||
    raw < SAMPLE_MIN ||
    raw >= HIGH_LIMIT ||
    r1 ||
    r2 ||
    doseUsed
  ) {
    replyError(
      409,
      "Dose unavailable in current state"
    );

    return;
  }

  float volume;
  float ratio;
  float flow;

  if (
    !numArg(
      "petrolMl",
      1,
      10000,
      volume
    ) ||
    !numArg(
      "ratio",
      0.01,
      100,
      ratio
    ) ||
    !numArg(
      "flow",
      0.01,
      1000,
      flow
    )
  ) {
    replyError(
      400,
      "Invalid dose inputs"
    );

    return;
  }

  float ms =
    volume *
    ratio /
    flow;

  if (
    ms < 100 ||
    ms > 60000
  ) {
    replyError(
      400,
      "Calculated run outside 0.1 to 60 s"
    );

    return;
  }

  doseMl =
    volume *
    ratio /
    1000;

  doseUsed = true;

  doseResult =
    "Dispensing";

  startPump(
    2,
    lroundf(ms),
    false
  );

  sendStatus();
}

// ============================================================
// CALIBRATION
// ============================================================

void handleCalibration() {
  if (!authenticated()) return;

  if (
    capturing ||
    r1 ||
    r2 ||
    automatic
  ) {
    replyError(
      409,
      "Use manual hold with both pumps OFF"
    );

    return;
  }

  if (
    !fsReady ||
    pointCount >= 12
  ) {
    replyError(
      409,
      "Storage unavailable or 12-point limit reached"
    );

    return;
  }

  float e;

  if (
    !numArg(
      "ethanol",
      0,
      100,
      e
    )
  ) {
    replyError(
      400,
      "Known ethanol percentage must be 0 to 100"
    );

    return;
  }

  String name =
    server.arg("name");

  name.trim();

  if (
    !name.length() ||
    name.length() > 24
  ) {
    replyError(
      400,
      "Name must be 1 to 24 characters"
    );

    return;
  }

  strlcpy(
    capture.name,
    name.c_str(),
    25
  );

  capture.ethanol = e;

  captureAt = millis();

  captureN = 0;
  captureSum = 0;
  captureSquares = 0;

  capturing = true;

  captureResult =
    "Capturing for 10 seconds";

  logEvent(
    "info",
    String("Calibration started: ") +
    name +
    " E" +
    String(e, 1)
  );

  sendStatus();
}

void listCalibration() {
  DynamicJsonDocument d(4096);

  d["ok"] = true;

  JsonArray a =
    d.createNestedArray("points");

  for (
    int i = 0;
    i < pointCount;
    i++
  ) {
    JsonObject o =
      a.createNestedObject();

    o["name"] =
      points[i].name;

    o["ethanol"] =
      points[i].ethanol;

    o["mean"] =
      points[i].mean;

    o["sd"] =
      points[i].sd;

    o["n"] =
      points[i].n;
  }

  jsonSend(d);
}

// ============================================================
// LOG API
// ============================================================

void sendLogs() {
  uint32_t after =
    strtoul(
      server.arg("after").c_str(),
      nullptr,
      10
    );

  uint32_t first =
    eventId > 64
      ? eventId - 63
      : 1;

  DynamicJsonDocument d(12500);

  d["ok"] = true;
  d["bootId"] = bootId;

  d["latest"] =
    eventId;

  d["oldest"] =
    first;

  d["lost"] =
    after > 0 &&
    after + 1 < first;

  JsonArray a =
    d.createNestedArray("events");

  for (
    uint32_t id = first;
    id <= eventId;
    id++
  ) {
    if (id <= after) {
      continue;
    }

    Event &e =
      events[(id - 1) % 64];

    JsonObject o =
      a.createNestedObject();

    o["id"] = e.id;
    o["ms"] = e.ms;
    o["sampleId"] = e.sample;
    o["level"] = e.level;
    o["text"] = e.text;
  }

  jsonSend(d);
}

// ============================================================
// SETUP
// ============================================================

void setup() {
  // ----------------------------------------------------------
  // Relays
  // ----------------------------------------------------------

  digitalWrite(R1, HIGH);
  digitalWrite(R2, HIGH);

  pinMode(R1, OUTPUT);
  pinMode(R2, OUTPUT);

  // ----------------------------------------------------------
  // Indicators
  // ----------------------------------------------------------

  for (
    uint8_t p :
    {RED, GREEN, BUZZER}
  ) {
    digitalWrite(p, LOW);
    pinMode(p, OUTPUT);
  }

  pinMode(LDR, INPUT);

  // ----------------------------------------------------------
  // Wi-Fi AP
  // ----------------------------------------------------------

  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);

  bool configured =
    WiFi.softAPConfig(
      IPAddress(192, 168, 4, 1),
      IPAddress(192, 168, 4, 1),
      IPAddress(255, 255, 255, 0)
    );

  apReady =
    WiFi.softAP(
      AP_NAME,
      AP_PASSWORD,
      1,
      false,
      4
    ) &&
    configured;

  // ----------------------------------------------------------
  // Excitation
  // ----------------------------------------------------------

  digitalWrite(EXCITE, LOW);
  pinMode(EXCITE, OUTPUT);

  delay(50);

  digitalWrite(EXCITE, HIGH);

  delay(200);

  // ----------------------------------------------------------
  // OLED
  // ----------------------------------------------------------

  display.begin();
  display.setContrast(200);

  // ----------------------------------------------------------
  // LittleFS
  // ----------------------------------------------------------

  LittleFS.setConfig(
    LittleFSConfig(false)
  );

  fsReady =
    LittleFS.begin();

  // ----------------------------------------------------------
  // Boot ID
  // ----------------------------------------------------------

  bootId =
    String(ESP.getChipId(), HEX) +
    "-" +
    String(os_random(), HEX);

  logEvent(
    "info",
    "FuelGuard started; automatic mode"
  );

  loadCalibration();

  // ----------------------------------------------------------
  // Required request headers
  // ----------------------------------------------------------

  server.collectHeaders("X-FuelGuard", "Authorization");

  // ----------------------------------------------------------
  // GET routes
  // ----------------------------------------------------------

  server.on(
    "/api/status",
    HTTP_GET,
    sendStatus
  );

  server.on(
    "/api/logs",
    HTTP_GET,
    sendLogs
  );

  server.on(
    "/api/calibration",
    HTTP_GET,
    listCalibration
  );

  // ----------------------------------------------------------
  // POST routes
  // ----------------------------------------------------------

  server.on(
    "/api/login",
    HTTP_POST,
    handleLogin
  );

  server.on(
    "/api/mode",
    HTTP_POST,
    handleMode
  );

  server.on(
    "/api/pump",
    HTTP_POST,
    handlePump
  );

  server.on(
    "/api/stop",
    HTTP_POST,
    handleStop
  );

  server.on(
    "/api/booster",
    HTTP_POST,
    handleDose
  );

  // ----------------------------------------------------------
  // Heartbeat
  // ----------------------------------------------------------

  server.on(
    "/api/heartbeat",
    HTTP_POST,
    []() {
      if (!authenticated()) {
        return;
      }

      leaseAt = millis();

      server.send(
        200,
        "application/json",
        "{\"ok\":true}"
      );
    }
  );

  // ----------------------------------------------------------
  // Calibration POST
  // ----------------------------------------------------------

  server.on(
    "/api/calibration",
    HTTP_POST,
    handleCalibration
  );

  // ----------------------------------------------------------
  // Cancel calibration
  // ----------------------------------------------------------

  server.on(
    "/api/calibration/cancel",
    HTTP_POST,
    []() {
      if (!authenticated()) {
        return;
      }

      capturing = false;

      captureResult =
        "Cancelled";

      logEvent(
        "info",
        "Calibration cancelled"
      );

      sendStatus();
    }
  );

  // ----------------------------------------------------------
  // Delete calibration
  // ----------------------------------------------------------

  server.on(
    "/api/calibration/delete",
    HTTP_POST,
    []() {
      if (!authenticated()) {
        return;
      }

      if (
        capturing ||
        r1 ||
        r2 ||
        automatic
      ) {
        replyError(
          409,
          "Use manual hold"
        );

        return;
      }

      float i;

      if (
        !pointCount ||
        !numArg(
          "index",
          0,
          pointCount - 1,
          i
        ) ||
        floorf(i) != i
      ) {
        replyError(
          400,
          "Invalid point"
        );

        return;
      }

      Point backup[12];

      memcpy(
        backup,
        points,
        sizeof(points)
      );

      for (
        int j = int(i);
        j < pointCount - 1;
        j++
      ) {
        points[j] =
          points[j + 1];
      }

      pointCount--;

      if (!saveCalibration()) {
        pointCount++;

        memcpy(
          points,
          backup,
          sizeof(points)
        );

        replyError(
          500,
          "Save failed"
        );

        return;
      }

      logEvent(
        "info",
        "Calibration point deleted"
      );

      listCalibration();
    }
  );

  // ----------------------------------------------------------
  // Settings
  // ----------------------------------------------------------

  server.on(
    "/api/settings",
    HTTP_POST,
    []() {
      if (!authenticated()) {
        return;
      }

      if (
        r1 ||
        r2 ||
        capturing ||
        phase == COUNTDOWN
      ) {
        replyError(
          409,
          "Operation in progress"
        );

        return;
      }

      float s;

      if (
        !numArg(
          "flushMaxSeconds",
          1,
          60,
          s
        ) ||
        floorf(s) != s
      ) {
        replyError(
          400,
          "Use 1 to 60 whole seconds"
        );

        return;
      }

      flushMaxMs =
        s * 1000;

      logEvent(
        "info",
        String("Flush cutoff set to ") +
        String(s, 0) +
        " s"
      );

      sendStatus();
    }
  );

  // ----------------------------------------------------------
  // Static dashboard
  // ----------------------------------------------------------

  if (fsReady) {
    server.serveStatic(
      "/",
      LittleFS,
      "/",
      "no-cache"
    );
  }

  // ----------------------------------------------------------
  // 404
  // ----------------------------------------------------------

  server.onNotFound(
    []() {
      replyError(
        404,
        "File missing; upload the data folder to LittleFS"
      );
    }
  );

  // ----------------------------------------------------------
  // Start server
  // ----------------------------------------------------------

  server.begin();
  if (MDNS.begin("fuelguard")) {
  MDNS.addService("http", "tcp", 80);
}

  raw = analogRead(A0);

  ldrValue =
    ldrCandidate =
    digitalRead(LDR);

  enter(WELCOME);

  tickIndicators();
  drawOled();
}

// ============================================================
// LOOP
// ============================================================

void loop() {
  tickControl();
  tickIndicators();
  drawOled();

  server.handleClient();
  MDNS.update();

  delay(1);
}