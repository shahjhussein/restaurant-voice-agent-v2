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
 *  EXPRESS APP
 * ---------------------------------------------------- */

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Restaurant AI Voice Agent - Online");
});

/* ----------------------------------------------------
 *  HTTP SERVER + MANUAL WS UPGRADE ON /media
 * ---------------------------------------------------- */

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrades explicitly (Render needs this)
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* ----------------------------------------------------
 *  TWILIO MEDIA STREAM HANDLING
 * ---------------------------------------------------- */

wss.on("connection", (ws, req) => {
  console.log("🔌 Twilio Media Stream CONNECTED on path:", req.url);

  // Per-call OpenAI WS + queue
  const ai = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let aiReady = false;
  const aiQueue = [];

  ai.on("open", () => {
    console.log("🧠 OpenAI Realtime CONNECTED");
    aiReady = true;

    // Session config
    ai.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
You are a friendly AI receptionist for a restaurant.
Speak naturally in British English.
Keep responses short and helpful.
Ask for: name, date, time, and number of guests.
Use light small talk but stay focused on taking the booking.
          `.trim(),
          modalities: ["audio"],
          voice: "alloy",
        },
      })
    );

    // Immediate greeting
    ai.send(
      JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio"] },
      })
    );

    // Flush queued audio messages
    for (const msg of aiQueue) {
      ai.send(msg);
    }
    aiQueue.length = 0;
  });

  ai.on("error", (err) => console.error("❌ OpenAI error:", err));
  ai.on("close", () => console.log("⭕ OpenAI WebSocket closed"));

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

      // Pad tiny frames (safety)
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

      // Float32 → PCM16 Buffer (for OpenAI)
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
 *  TWILIO VOICE WEBHOOK  (/twilio/voice)
 * ---------------------------------------------------- */

app.post("/twilio/voice", (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();

  // IMPORTANT: WebSocket URL MUST MATCH the upgrade path
  connect.stream({
    url: "wss://restaurant-voice-agent-v2.onrender.com/media",
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
