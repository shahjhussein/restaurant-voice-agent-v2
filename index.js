import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

/* ----------------------------------------------------
 *  PURE JS μ-LAW (G.711) ENCODER + DECODER
 * ---------------------------------------------------- */

function linearToMuLawSample(sample) {
  const MAX = 32635;
  sample = Math.max(-MAX, Math.min(MAX, sample));
  let sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> ((exponent === 0) ? 4 : exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawToLinear(mu) {
  mu = ~mu & 0xff;
  let sign = mu & 0x80;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + 8) << (exponent + 3);
  return sign ? -sample : sample;
}

/* ----------------------------------------------------
 *  SIMPLE LINEAR RESAMPLER (Float32Array)
 * ---------------------------------------------------- */

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = toRate / fromRate;
  const outLen = Math.floor(input.length * ratio);
  const output = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIndex - i0;
    output[i] = (1 - t) * input[i0] + t * input[i1];
  }

  return output;
}

/* ----------------------------------------------------
 *  CONNECT TO OPENAI REALTIME
 * ---------------------------------------------------- */

function connectToOpenAI() {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  ws.on("open", () => {
    console.log("🧠 Connected to OpenAI Realtime");

    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: `
You are a friendly restaurant AI receptionist.
Speak naturally, British English.
Keep responses short.
Ask for name, date, time, and number of guests.
        `.trim(),
        modalities: ["audio"],
        voice: "alloy"
      }
    }));

    // ❗ FORCE IMMEDIATE GREETING
    ws.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"] }
    }));
  });

  ws.on("error", (err) => console.error("❌ OpenAI error:", err));
  ws.on("close", () => console.log("⭕ OpenAI WebSocket closed"));
  return ws;
}

/* ----------------------------------------------------
 *  EXPRESS APP
 * ---------------------------------------------------- */

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Restaurant AI Voice Agent - Online");
});

/* ----------------------------------------------------
 *  HTTP + WSS SERVER
 * ---------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ----------------------------------------------------
 *  TWILIO MEDIA STREAM HANDLING
 * ---------------------------------------------------- */

wss.on("connection", (ws) => {
  console.log("🔌 Twilio Media Stream CONNECTED");

  const ai = connectToOpenAI();

  /* ------------------------------------------------
   *  OPENAI → TWILIO  (AI SPEAKS)
   * ------------------------------------------------ */
  ai.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    console.log("🔈 OpenAI event:", msg.type);

    if (
      msg.type === "response.audio.delta" ||
      msg.type === "response.output_audio.delta"
    ) {
      const pcmBuf = Buffer.from(msg.delta, "base64");

      // PCM16 → Float32
      const pcmFloat = new Float32Array(pcmBuf.length / 2);
      for (let i = 0; i < pcmFloat.length; i++) {
        pcmFloat[i] = pcmBuf.readInt16LE(i * 2) / 32768;
      }

      // 24k → 8k
      const pcm8 = resampleLinear(pcmFloat,
