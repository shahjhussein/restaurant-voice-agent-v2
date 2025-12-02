import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

/**
 * ----------------------------------------------------
 *  PURE JS μ-LAW (G.711) ENCODER + DECODER
 * ----------------------------------------------------
 */

// PCM16 -> μ-law byte
function linearToMuLawSample(sample) {
  const MAX = 32635;
  sample = Math.max(-MAX, Math.min(MAX, sample));

  let sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  const mu = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mu;
}

// μ-law byte -> PCM16 sample
function muLawToLinear(muLawByte) {
  muLawByte = ~muLawByte & 0xff;

  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0F;

  let sample = ((mantissa << 4) + 0x08) << (exponent + 3);
  if (sign) sample = -sample;

  return sample;
}

/**
 * ----------------------------------------------------
 *  SIMPLE LINEAR RESAMPLER (Float32 -> Float32)
 * ----------------------------------------------------
 * fromRate: original sample rate (e.g. 8000)
 * toRate:   target sample rate (e.g. 24000)
 */
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = toRate / fromRate;
  const outLength = Math.floor(input.length * ratio);
  const output = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i / ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcIndex - i0;
    output[i] = (1 - t) * input[i0] + t * input[i1];
  }

  return output;
}

/**
 * ----------------------------------------------------
 *  CONNECT TO OPENAI REALTIME (WebSocket)
 * ----------------------------------------------------
 */
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
You are a friendly AI receptionist for a restaurant.
- Greet callers warmly.
- Ask for date, time, number of guests, name, and phone number.
- Speak clearly and concisely.
- You may do light small talk, but stay focused on booking the reservation.
- Speak British English.
        `.trim(),
        modalities: ["audio"],
        voice: "alloy"
      }
    }));
  });

  ws.on("close", () => console.log("⭕ OpenAI WebSocket closed"));
  ws.on("error", (err) => console.error("❌ OpenAI WebSocket error:", err));

  return ws;
}

/**
 * ----------------------------------------------------
 *  EXPRESS APP
 * ----------------------------------------------------
 */
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Restaurant AI Voice Agent - Server Running on Render");
});

/**
 * ----------------------------------------------------
 *  HTTP + WEBSOCKET SERVER
 * ----------------------------------------------------
 */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * ----------------------------------------------------
 *  HANDLE TWILIO MEDIA STREAM CONNECTION
 * ----------------------------------------------------
 */
wss.on("connection", (ws) => {
  console.log("🔌 Twilio media stream connected");

  // Create OpenAI session for this call
  const openAiWs = connectToOpenAI();

  // --------------- OPENAI → TWILIO (AI speaks) ---------------
  openAiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "response.audio.delta" && msg.delta) {
      // 1) Decode PCM16 from base64
      const pcmBuffer = Buffer.from(msg.delta, "base64");

      // 2) PCM16 -> Float32
      const pcmFloat = new Float32Array(pcmBuffer.length / 2);
      for (let i = 0; i < pcmFloat.length; i++) {
        pcmFloat[i] = pcmBuffer.readInt16LE(i * 2) / 32768;
      }

      // 3) Resample 24k -> 8k for Twilio
      const pcm8k = resampleLinear(pcmFloat, 24000, 8000);

      // 4) Float32 -> Int16
      const pcmInt16 = new Int16Array(pcm8k.length);
      for (let i = 0; i < pcm8k.length; i++) {
        let v = Math.max(-1, Math.min(1, pcm8k[i]));
        pcmInt16[i] = v * 32767;
      }

      // 5) Int16 -> μ-law bytes
      const mulawBuffer = Buffer.alloc(pcmInt16.length);
      for (let i = 0; i < pcmInt16.length; i++) {
        mulawBuffer[i] = linearToMuLawSample(pcmInt16[i]);
      }

      // 6) Send back to Twilio
      ws.send(JSON.stringify({
        event: "media",
        media: {
          payload: mulawBuffer.toString("base64")
        }
      }));
    }
  });

  // --------------- TWILIO → OPENAI (caller speaks) ---------------
  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      console.log("🟢 Media stream started:", data.streamSid);
    }

    if (data.event === "media") {
      // 1) Base64 μ-law → Buffer
      const mulawBuffer = Buffer.from(data.media.payload, "base64");

      // 2) μ-law bytes -> PCM16 Int16Array
      const pcmInt16 = new Int16Array(mulawBuffer.length);
      for (let i = 0; i < mulawBuffer.length; i++) {
        pcmInt16[i] = muLawToLinear(mulawBuffer[i]);
      }

      // 3) Int16 -> Float32
      const pcmFloat = new Float32Array(pcmInt16.length);
      for (let i = 0; i < pcmInt16.length; i++) {
        pcmFloat[i] = pcmInt16[i] / 32768;
      }

      // 4) Resample 8k -> 24k for OpenAI
      const pcm24k = resampleLinear(pcmFloat, 8000, 24000);

      // 5) Float32 -> Int16 Buffer for OpenAI
      const pcm24kInt16 = Buffer.alloc(pcm24k.length * 2);
      for (let i = 0; i < pcm24k.length; i++) {
        let v = Math.max(-1, Math.min(1, pcm24k[i]));
        pcm24kInt16.writeInt16LE(v * 32767, i * 2);
      }

      // 6) Send audio into OpenAI Realtime
      openAiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcm24kInt16.toString("base64")
      }));

      // 7) Ask OpenAI to generate a response
      openAiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    }

    if (data.event === "stop") {
      console.log("🔴 Media stream stopped:", data.streamSid);
      openAiWs.close();
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    try {
      openAiWs.close();
    } catch {
      // ignore
    }
  });
});

/**
 * ----------------------------------------------------
 *  TWILIO VOICE WEBHOOK (INBOUND CALL)
 * ----------------------------------------------------
 */
app.post("/twilio/voice", (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    // TODO: replace with your actual Render URL if different
    url: "wss://restaurant-voice-agent-v2.onrender.com/twilio-media-stream"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

/**
 * ----------------------------------------------------
 *  START SERVER
 * ----------------------------------------------------
 */
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Server listening on port", port);
});
