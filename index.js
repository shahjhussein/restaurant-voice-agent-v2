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
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
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
 *  CONNECT TO OPENAI REALTIME (NO HANDLERS ATTACHED)
 * ---------------------------------------------------- */

function createOpenAIWebSocket() {
  const ws = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

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

  // Per-call OpenAI WS + queue
  const ai = createOpenAIWebSocket();
  let aiReady = false;
  const aiQueue = [];

  // When OpenAI is ready, set up session + flush queued audio
  ai.on("open", () => {
    console.log("🧠 OpenAI Realtime CONNECTED");
    aiReady = true;

    // Session config
    const sessionUpdate = JSON.stringify({
      type: "session.update",
      session: {
        instructions: `
You are a friendly restaurant AI receptionist.
Speak naturally in British English.
Keep responses short and helpful.
Ask for: name, date, time, and number of guests.
You can do light small talk but stay focused on the booking.
        `.trim(),
        modalities: ["audio"],
        voice: "alloy",
      },
    });

    ai.send(sessionUpdate);

    // Immediate greeting
    const greeting = JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio"] },
    });
    ai.send(greeting);

    // Flush queued audio messages (if any arrived while connecting)
    for (const msg of aiQueue) {
      ai.send(msg);
    }
    aiQueue.length = 0;
  });

  /* ------------------------------------------------
   *  OPENAI → TWILIO  (AI SPEAKS)
   * ------------------------------------------------ */

  ai.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Debug log
    // console.log("OpenAI event:", msg.type);

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
      const pcm8 = resampleLinear(pcmFloat, 24000, 8000);

      // Float32 → PCM16
      const pcm16 = new Int16Array(pcm8.length);
      for (let i = 0; i < pcm8.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm8[i]));
        pcm16[i] = v * 32767;
      }

      // PCM16 → μ-law
      let mu = Buffer.alloc(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        mu[i] = linearToMuLawSample(pcm16[i]);
      }

      // Pad small frames for safety
      if (mu.length < 160) {
        const padded = Buffer.alloc(160);
        mu.copy(padded);
        mu = padded;
      }

      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: mu.toString("base64") },
        })
      );
    }
  });

  /* ------------------------------------------------
   *  TWILIO → OPENAI  (CALLER SPEAKS)
   * ------------------------------------------------ */

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      console.log("🟢 Stream START:", data.streamSid);
      return;
    }

    if (data.event === "stop") {
      console.log("🔴 Stream STOP:", data.streamSid);
      try {
        ai.close();
      } catch {}
      return;
    }

    if (data.event === "media") {
      const mulawBuf = Buffer.from(data.media.payload, "base64");

      // μ-law → PCM16
      const pcm16 = new Int16Array(mulawBuf.length);
      for (let i = 0; i < mulawBuf.length; i++) {
        pcm16[i] = muLawToLinear(mulawBuf[i]);
      }

      // PCM16 → Float32
      const pcmFloat = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        pcmFloat[i] = pcm16[i] / 32768;
      }

      // 8k → 24k
      const pcm24 = resampleLinear(pcmFloat, 8000, 24000);

      // Float32 → PCM16 Buffer for OpenAI
      const outBuf = Buffer.alloc(pcm24.length * 2);
      for (let i = 0; i < pcm24.length; i++) {
        const v = Math.max(-1, Math.min(1, pcm24[i]));
        outBuf.writeInt16LE(v * 32767, i * 2);
      }

      const appendMsg = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: outBuf.toString("base64"),
      });

      const commitMsg = JSON.stringify({
        type: "input_audio_buffer.commit",
      });

      const responseMsg = JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"] },
      });

      // If OpenAI is ready, send immediately. Otherwise queue.
      if (aiReady && ai.readyState === WebSocket.OPEN) {
        ai.send(appendMsg);
        ai.send(commitMsg);
        ai.send(responseMsg);
      } else {
        aiQueue.push(appendMsg, commitMsg, responseMsg);
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WebSocket CLOSED");
    try {
      ai.close();
    } catch {}
  });
});

/* ----------------------------------------------------
 *  TWILIO VOICE WEBHOOK
 * ---------------------------------------------------- */

app.post("/twilio/voice", (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();

  // IMPORTANT: WSS at ROOT (no /twilio-media-stream path)
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com",
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

/* ----------------------------------------------------
 *  START SERVER
 * ---------------------------------------------------- */

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Server listening on port", port);
});
